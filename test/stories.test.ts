import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { boardTools, type BoardAccess } from '../src/main/board-tools.ts';
import { openDb } from '../src/main/db.ts';
import { orbitServer, decisionTools, DecisionStore } from '../src/main/decisions.ts';
import {
  STORY_MODEL_CAP,
  StoryStore,
  capStoryModel,
  deliverMail,
  dismissStory,
  forwardAnswer,
  moonTools,
  pmStoryTools,
  reportMessage,
  storyConfig,
  storyKickoff,
  storyLaneId,
  sweepStories,
  unstartedMoons,
  wakeWaiting,
  type MoonHost,
} from '../src/main/stories.ts';
import { boardTool, laneTools, type LaneSink } from '../src/main/lane-tools.ts';
import { STARTER } from '../src/main/starter.ts';
import type { LaneStatus, StoryConfig } from '../src/shared/types.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'orbit-stories-'));
const shop = { id: 'shop', name: 'Storefront', cwd: 'C:\\src\\storefront' };

/**
 * A host that remembers what the tools asked of it; sends succeed unless the lane is busy, and a
 * lane listed in `dead` never comes up when started or resumed.
 */
function fakeHost() {
  const live = new Set<string>();
  const busy = new Set<string>();
  const dead = new Set<string>();
  const status = new Map<string, LaneStatus>();
  const sessions = new Map<string, string>();
  const sent: Array<{ laneId: string; text: string }> = [];
  const added: Array<StoryConfig & { kind: 'story' }> = [];
  const removed: string[] = [];
  const stopped: string[] = [];
  const resumed: Array<[string, string]> = [];
  const host: MoonHost & {
    live: Set<string>;
    busy: Set<string>;
    dead: Set<string>;
    status: typeof status;
    sessions: typeof sessions;
    sent: typeof sent;
    added: typeof added;
    removed: string[];
    stopped: string[];
    resumed: typeof resumed;
  } = {
    live,
    busy,
    dead,
    status,
    sessions,
    sent,
    added,
    removed,
    stopped,
    resumed,
    isLive: (id) => live.has(id),
    lane: (id) => ({
      status: status.get(id) ?? (live.has(id) ? 'idle' : 'stopped'),
      sessionId: sessions.get(id) ?? null,
    }),
    send: (laneId, text) => {
      if (busy.has(laneId)) return false;
      sent.push({ laneId, text });
      return true;
    },
    addTransient: (cfg) => {
      added.push(cfg);
      return true;
    },
    removeTransient: (id) => {
      if (live.has(id)) return false;
      removed.push(id);
      return true;
    },
    start: (id) => {
      if (!dead.has(id)) live.add(id);
    },
    resume: (id, sessionId) => {
      resumed.push([id, sessionId]);
      if (!dead.has(id)) live.add(id);
    },
    stop: async (id) => {
      stopped.push(id);
      live.delete(id);
    },
  };
  return host;
}

const moonBase = {
  parentId: 'shop',
  parentName: shop.name,
  cwd: shop.cwd,
  agent: 'story-manager',
  model: null,
  brief: 'go',
};

const callerFor = (server: unknown) => {
  const reg = (
    server as {
      instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> };
    }
  ).instance._registeredTools;
  return async (name: string, args: Record<string, unknown>) => {
    assert.ok(reg[name], `${name} is registered`);
    return (await reg[name].handler(args, {})) as { isError?: boolean; content: Array<{ text: string }> };
  };
};

test('the store keeps stories and mail in the database, counts what is in flight, and finds file conflicts', () => {
  const file = path.join(dir, 'a', 'orbit.db');
  let now = 100;
  const store = new StoryStore(openDb(file), { now: () => now });
  const base = {
    parentId: 'shop',
    parentName: shop.name,
    cwd: shop.cwd,
    agent: 'story-manager',
    model: null,
    brief: 'go',
  };
  const a = store.add({ ...base, id: storyLaneId('shop', '1'), storyId: '1', title: 'One' });
  now = 200;
  store.add({ ...base, id: storyLaneId('shop', '2'), storyId: '2', title: 'Two' });
  assert.equal(a.stage, 'starting');
  assert.equal(store.inFlight('shop').length, 2);

  store.update(a.id, { files: ['libs/a/x.ts', 'LIBS/a/y.ts'] });
  assert.deepEqual(store.conflicts(storyLaneId('shop', '2'), ['libs/a/X.ts', 'libs/b/z.ts']), [
    { storyId: '1', files: ['libs/a/x.ts'] },
  ]);
  // A finished story holds nothing.
  store.update(a.id, { stage: 'pr-opened', pr: 7123 });
  assert.equal(store.inFlight('shop').length, 1);
  assert.deepEqual(store.conflicts(storyLaneId('shop', '2'), ['libs/a/x.ts']), []);

  store.update(storyLaneId('shop', '2'), { stage: 'waiting', waitingOn: ['9'], waitingFiles: ['libs/c/w.ts'] });
  store.post('shop', 'hello');
  assert.equal(store.pending('shop').length, 1);
  const again = new StoryStore(openDb(file));
  assert.equal(again.list().length, 2);
  assert.equal(again.get(a.id)?.stage, 'pr-opened', 'updates reach the database');
  assert.deepEqual(again.get(a.id)?.waitingOn, []);
  assert.deepEqual(again.get(storyLaneId('shop', '2'))?.waitingOn, ['9']);
  assert.deepEqual(again.get(storyLaneId('shop', '2'))?.waitingFiles, ['libs/c/w.ts']);
  assert.equal(again.pending('shop')[0].text, 'hello');

  const taken = store.take('shop');
  assert.deepEqual(new StoryStore(openDb(file)).pending('shop'), [], 'taken mail is gone from disk');
  store.putBack(taken);
  assert.equal(new StoryStore(openDb(file)).pending('shop').length, 1, 'and put back');
  store.remove(a.id);
  assert.equal(new StoryStore(openDb(file)).get(a.id), undefined);
});

test('a PM can start stories up to its cap, not twice, and read them back; a finished one can be started again', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const host = fakeHost();
  const call = callerFor(
    orbitServer(
      pmStoryTools(store, host, shop, { cap: 2, model: 'sonnet', agent: 'story-manager', skill: 'story-engine' }),
    ),
  );

  const first = await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'Traps: none.' });
  assert.equal(first.isError, undefined);
  assert.match(first.content[0].text, /^Started story 100203 on its own moon \(1 of 2 in flight\)/);
  assert.equal(host.added.length, 1);
  const cfg = host.added[0];
  assert.equal(cfg.kind, 'story');
  assert.equal(cfg.id, 'story-shop-100203');
  assert.equal(cfg.parentId, 'shop');
  assert.equal(cfg.name, '100203 · Delivery question');
  assert.equal(cfg.agent, 'story-manager');
  assert.equal(cfg.model, 'sonnet');
  assert.match(cfg.brief, /^You are the story manager for story 100203: Delivery question\./);
  assert.match(cfg.brief, /The PM's brief:\nTraps: none\.$/);
  assert.ok(host.live.has('story-shop-100203'), 'started');

  const twice = await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'x' });
  assert.equal(twice.isError, true);
  assert.match(twice.content[0].text, /already running \(starting\)/);

  await call('start_story', { storyId: '100204', title: 'Shopper N/A', brief: 'x' });
  const third = await call('start_story', { storyId: '100205', title: 'Three', brief: 'x' });
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /2 of 2 stories are in flight \(100203 \(starting\), 100204 \(starting\)\)/);

  const status = await call('story_status', {});
  assert.match(
    status.content[0].text,
    /^100203 Delivery question — starting, running\n100204 Shopper N\/A — starting, running$/,
  );

  store.update('story-shop-100203', { stage: 'failed', summary: 'Gates red twice.' });
  host.live.delete('story-shop-100203');
  const retry = await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'x' });
  assert.equal(retry.isError, undefined);
  assert.deepEqual(host.removed, ['story-shop-100203']);
  assert.equal(store.get('story-shop-100203')?.stage, 'starting');
});

/** A host whose automatic starts wait for memory: nothing it starts comes up, it is held instead. */
function holdingHost() {
  const host = fakeHost();
  const held = new Set<string>();
  return Object.assign(host, {
    heldIds: held,
    held: (id: string) => held.has(id),
    start: (id: string) => {
      held.add(id);
    },
  });
}

test('start_story while held says held, not failed', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const host = holdingHost();
  const call = callerFor(
    orbitServer(
      pmStoryTools(store, host, shop, { cap: 2, model: null, agent: 'story-manager', skill: 'story-engine' }),
    ),
  );
  const res = await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'x' });
  assert.equal(res.isError, undefined);
  assert.match(
    res.content[0].text,
    /^Story 100203 is on its own moon \(1 of 2 in flight\), but Orbit is holding its start until memory frees up; it starts by itself\. Do not start_story it again\./,
  );
  assert.equal(store.get('story-shop-100203')?.stage, 'starting');
});

test('unstartedMoons finds stories that never got a session, so a restart can start them again', () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const host = fakeHost();
  const add = (storyId: string) =>
    store.add({ ...moonBase, id: storyLaneId('shop', storyId), storyId, title: storyId });
  add('1');
  add('2');
  add('3');
  add('4');
  host.sessions.set(storyLaneId('shop', '2'), 's2');
  host.live.add(storyLaneId('shop', '3'));
  store.update(storyLaneId('shop', '4'), { stage: 'failed' });
  assert.deepEqual(unstartedMoons(store, host), [storyLaneId('shop', '1')]);
});

test('story_status shows held for memory', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const host = holdingHost();
  const call = callerFor(
    orbitServer(
      pmStoryTools(store, host, shop, { cap: 2, model: null, agent: 'story-manager', skill: 'story-engine' }),
    ),
  );
  await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'x' });
  const status = await call('story_status', {});
  assert.equal(status.content[0].text, '100203 Delivery question — starting, held for memory');
});

test('a moon claims files, is refused ones another story holds, and its reports reach the PM between turns', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 9 });
  const host = fakeHost();
  const base = {
    parentId: 'shop',
    parentName: shop.name,
    cwd: shop.cwd,
    agent: 'story-manager',
    model: null,
    brief: 'go',
  };
  const one = store.add({ ...base, id: storyLaneId('shop', '1'), storyId: '1', title: 'One' });
  const two = store.add({ ...base, id: storyLaneId('shop', '2'), storyId: '2', title: 'Two' });
  const moon1 = callerFor(orbitServer(moonTools(store, host, one)));
  const moon2 = callerFor(orbitServer(moonTools(store, host, two)));

  const claimed = await moon1('claim_files', { paths: ['libs/a/x.ts', 'libs/a/y.ts'] });
  assert.match(claimed.content[0].text, /^Claimed 2 file\(s\); this story now holds 2\./);
  const refused = await moon2('claim_files', { paths: ['libs/a/y.ts', 'libs/c/z.ts'] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /- story 1 holds libs\/a\/y\.ts\nOrbit has parked this story/);
  assert.deepEqual(store.get(two.id)?.files, []);
  assert.equal(store.get(two.id)?.stage, 'waiting');
  // The PM is between runs, so the note that its story is waiting stays in the mail.
  assert.match(store.take('shop')[0].text, /^Story 2 is waiting on 1: Two\n/);

  // The PM is mid-turn: the report waits in the mail and goes when the PM is idle.
  host.live.add('shop');
  host.busy.add('shop');
  const planned = await moon1('report_to_pm', {
    stage: 'planned',
    summary: 'Architect split: client only.',
    worktree: 'C:\\src\\one',
    branch: 'users/pdoe/1-one',
  });
  assert.match(planned.content[0].text, /^Reported planned to Storefront\. Carry on/);
  assert.equal(store.get(one.id)?.stage, 'building');
  assert.equal(store.get(one.id)?.branch, 'users/pdoe/1-one');
  assert.equal(host.sent.length, 0);
  assert.equal(store.pending('shop').length, 1);
  host.busy.delete('shop');
  assert.equal(deliverMail(store, host, 'shop'), 1);
  assert.equal(store.pending('shop').length, 0);
  assert.match(
    host.sent[0].text,
    /^Story report 1 \(planned\): One\nArchitect split: client only\.\nFiles claimed: libs\/a\/x\.ts, libs\/a\/y\.ts$/,
  );

  const noPr = await moon1('report_to_pm', { stage: 'pr-opened', summary: 'Opened.' });
  assert.equal(noPr.isError, true);
  const opened = await moon1('report_to_pm', {
    stage: 'pr-opened',
    summary: 'Opened the PR.',
    pr: 7123,
    prUrl: 'https://github.com/x/y/pull/7123',
  });
  assert.match(opened.content[0].text, /You are finished with this story; end your turn now\./);
  assert.equal(store.get(one.id)?.stage, 'pr-opened');
  assert.equal(store.inFlight('shop').length, 1);
  assert.match(host.sent[1].text, /PR #7123 https:\/\/github\.com\/x\/y\/pull\/7123\. The story's moon is done/);

  // A send that cannot go stays queued rather than being lost.
  host.busy.add('shop');
  await moon2('report_to_pm', { stage: 'blocked', summary: 'AC contradicts legacy.' });
  assert.equal(deliverMail(store, host, 'shop'), 0);
  assert.equal(store.pending('shop').length, 1);
  assert.equal(store.get(two.id)?.stage, 'blocked');
  assert.deepEqual(store.get(two.id)?.waitingOn, [], 'a report ends the wait');
  assert.match(
    reportMessage(store.get(two.id)!, 'blocked', 'AC contradicts legacy.'),
    /Decide whether to answer it or let the story wait; start it again with start_story when it can go\.$/,
  );
});

test('a moon asks product questions tagged with its story without the agent having to say so', async () => {
  const decisions = new DecisionStore(openDb(':memory:'), { now: () => 1 });
  const call = callerFor(
    orbitServer(decisionTools(decisions, { id: 'story-shop-100203', name: '100203 · Delivery', story: '100203' })),
  );
  await call('ask_product_owner', {
    question: 'When a shopper picks up an order at a store, which store should the paperwork show?',
    today: 'The old app prints the store where the orders were picked up.',
  });
  assert.equal(decisions.open()[0].story, '100203');
  assert.equal(decisions.open()[0].laneId, 'story-shop-100203');
});

test('storyConfig and the kickoff carry what the session needs', () => {
  const rec = new StoryStore(openDb(':memory:')).add({
    id: 'story-shop-1',
    parentId: 'shop',
    parentName: shop.name,
    storyId: '1',
    title: 'One',
    brief: storyKickoff({
      storyId: '1',
      title: 'One',
      parentName: shop.name,
      brief: 'Trap: numbers are strings.',
      skill: 'story-engine',
    }),
    cwd: shop.cwd,
    agent: 'story-manager',
    model: null,
  });
  const cfg = storyConfig(rec);
  assert.equal(cfg.cwd, shop.cwd);
  assert.equal('model' in cfg, false);
  assert.match(cfg.brief, /Run the story-engine skill\./);
  assert.match(cfg.brief, /claim the files with claim_files/);
  assert.match(cfg.brief, /Trap: numbers are strings\.$/);
});

test('a moon never runs above Opus: Fable comes down, anything lower stays, a saved Fable moon restarts on Opus', () => {
  assert.equal(capStoryModel('us.anthropic.claude-fable-5-1[1m]'), 'us.anthropic.claude-opus-5-5');
  assert.equal(capStoryModel('fable'), 'opus');
  assert.equal(capStoryModel('claude-fable-5-1'), 'claude-opus-5-5', 'an Anthropic API id stays an API id');
  assert.equal(capStoryModel('eu.anthropic.claude-fable-5-1'), 'eu.anthropic.claude-opus-5-5');
  assert.equal(STORY_MODEL_CAP, 'claude-opus-5-5');
  assert.equal(capStoryModel('sonnet'), 'sonnet');
  assert.equal(capStoryModel('us.anthropic.claude-opus-5-5'), 'us.anthropic.claude-opus-5-5');
  assert.equal(capStoryModel(null), null);
  assert.equal(capStoryModel(undefined), null);

  const rec = new StoryStore(openDb(':memory:')).add({
    id: 'story-shop-2',
    parentId: 'shop',
    parentName: shop.name,
    storyId: '2',
    title: 'Two',
    brief: 'go',
    cwd: shop.cwd,
    agent: 'story-manager',
    model: 'us.anthropic.claude-fable-5-1[1m]',
  });
  assert.equal(storyConfig(rec).model, 'us.anthropic.claude-opus-5-5');
});

test('a finished moon can be dismissed, its session stopped first; one still in flight cannot', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 1 });
  const host = fakeHost();
  const base = {
    parentId: 'shop',
    parentName: shop.name,
    cwd: shop.cwd,
    agent: 'story-manager',
    model: null,
    brief: 'go',
  };
  const building = store.add({ ...base, id: storyLaneId('shop', '1'), storyId: '1', title: 'One' });
  const opened = store.add({ ...base, id: storyLaneId('shop', '2'), storyId: '2', title: 'Two' });
  store.update(building.id, { stage: 'building' });
  store.update(opened.id, { stage: 'pr-opened', pr: 7123 });
  host.live.add(building.id);
  host.live.add(opened.id);

  assert.equal(await dismissStory(store, host, building.id), false);
  assert.deepEqual(host.stopped, []);
  assert.ok(store.get(building.id));

  assert.equal(await dismissStory(store, host, opened.id), true);
  assert.deepEqual(host.stopped, [opened.id]);
  assert.deepEqual(host.removed, [opened.id]);
  assert.equal(store.get(opened.id), undefined);
  assert.equal(await dismissStory(store, host, opened.id), false);

  // A moon waiting on files has nothing to do until they free up, so you can let it go too.
  const waiting = store.add({ ...base, id: storyLaneId('shop', '3'), storyId: '3', title: 'Three' });
  store.update(waiting.id, { stage: 'waiting', waitingOn: ['1'] });
  assert.equal(await dismissStory(store, host, waiting.id), true);
  assert.equal(store.get(waiting.id), undefined);
});

test('a moon whose PR opened leaves by itself once the wait is up and it is not mid-turn', async () => {
  let now = 1_000;
  const store = new StoryStore(openDb(':memory:'), { now: () => now });
  const host = fakeHost();
  const base = {
    parentId: 'shop',
    parentName: shop.name,
    cwd: shop.cwd,
    agent: 'story-manager',
    model: null,
    brief: 'go',
  };
  const add = (n: string) => store.add({ ...base, id: storyLaneId('shop', n), storyId: n, title: n }).id;
  const [opened, busy, failed, blocked] = ['1', '2', '3', '4'].map(add);
  store.update(opened, { stage: 'pr-opened', pr: 1 });
  store.update(busy, { stage: 'pr-opened', pr: 2 });
  store.update(failed, { stage: 'failed' });
  store.update(blocked, { stage: 'blocked' });
  for (const id of [opened, busy, failed, blocked]) host.live.add(id);
  host.status.set(busy, 'working');

  now = 1_000 + 59_000;
  assert.deepEqual(await sweepStories(store, host, now, 60_000), []);

  now = 1_000 + 60_000;
  assert.deepEqual(await sweepStories(store, host, now, 60_000), [opened]);
  assert.deepEqual(host.stopped, [opened]);
  // Blocked and failed moons wait for you; so does one still working.
  assert.deepEqual(
    store.list().map((s) => s.id),
    [busy, failed, blocked],
  );

  host.status.set(busy, 'idle');
  assert.deepEqual(await sweepStories(store, host, now, 60_000), [busy]);
});

/** A story store with moons 1..n under Shop, each with its own claim and report tools. */
function moonsOf(n: number) {
  const store = new StoryStore(openDb(':memory:'), { now: () => 9 });
  const host = fakeHost();
  host.live.add('shop');
  const recs = Array.from({ length: n }, (_, i) =>
    store.add({ ...moonBase, id: storyLaneId('shop', String(i + 1)), storyId: String(i + 1), title: `Story ${i + 1}` }),
  );
  const tools = recs.map((r) => callerFor(orbitServer(moonTools(store, host, r))));
  const sentTo = (laneId: string) => host.sent.filter((s) => s.laneId === laneId).map((s) => s.text);
  return { store, host, recs, tools, sentTo };
}

test('a refused claim parks the moon as waiting: it keeps what it holds, still counts in flight, and its PM hears', async () => {
  const { store, host, recs, tools, sentTo } = moonsOf(3);
  const [one, two, three] = tools;
  await one('claim_files', { paths: ['libs/a/y.ts'] });
  await two('claim_files', { paths: ['libs/a/a.ts'] });

  const refused = await two('claim_files', { paths: ['libs/a/y.ts', 'libs/c/z.ts'] });
  assert.equal(refused.isError, true);
  assert.match(
    refused.content[0].text,
    /- story 1 holds libs\/a\/y\.ts\nOrbit has parked this story as waiting\. End your turn now; when the files are free, Orbit claims them for you and tells you to carry on\.$/,
  );
  const parked = store.get(recs[1].id)!;
  assert.equal(parked.stage, 'waiting');
  assert.deepEqual(parked.waitingOn, ['1']);
  assert.deepEqual(parked.waitingFiles, ['libs/a/y.ts', 'libs/c/z.ts']);
  assert.deepEqual(parked.files, ['libs/a/a.ts']);

  // It keeps its claims while it waits, and it still takes one of the PM's slots.
  const third = await three('claim_files', { paths: ['libs/a/a.ts'] });
  assert.match(third.content[0].text, /- story 2 holds libs\/a\/a\.ts/);
  assert.equal(store.inFlight('shop').length, 3);

  assert.match(
    sentTo('shop')[0],
    /^Story 2 is waiting on 1: Story 2\nStory 1 holds libs\/a\/y\.ts\. Orbit wakes it with the files claimed when they are free; do not start_story it\. It still counts toward your stories in flight\.$/,
  );
  const pm = callerFor(
    orbitServer(
      pmStoryTools(store, host, shop, { cap: 4, model: null, agent: 'story-manager', skill: 'story-engine' }),
    ),
  );
  assert.match((await pm('story_status', {})).content[0].text, /^2 Story 2 — waiting on 1, not running/m);
});

test('a waiting moon wakes once its files are free: Orbit claims them for it, and the moon and its PM hear', async () => {
  const { store, host, recs, tools, sentTo } = moonsOf(2);
  const [one, two] = tools;
  await one('claim_files', { paths: ['libs/a/y.ts'] });
  await two('claim_files', { paths: ['libs/a/a.ts'] });
  await two('report_to_pm', { stage: 'planned', summary: 'One lane.' });
  await two('claim_files', { paths: ['libs/a/y.ts', 'libs/c/z.ts'] });
  host.live.add(recs[1].id);
  assert.deepEqual(wakeWaiting(store, host), [], 'nothing is free yet');

  await one('report_to_pm', { stage: 'pr-opened', summary: 'Opened.', pr: 1 });
  assert.deepEqual(wakeWaiting(store, host), [recs[1].id]);
  const woke = store.get(recs[1].id)!;
  assert.equal(woke.stage, 'building', 'back where it was: it had planned');
  assert.deepEqual(woke.files, ['libs/a/a.ts', 'libs/a/y.ts', 'libs/c/z.ts']);
  assert.deepEqual(woke.waitingOn, []);
  assert.deepEqual(woke.waitingFiles, []);
  assert.deepEqual(sentTo(recs[1].id), [
    'The files you waited on are free and now claimed for this story: libs/a/y.ts, libs/c/z.ts. Carry on from where you stopped.',
  ]);
  assert.match(
    sentTo('shop').at(-1)!,
    /^Story 2 is back to work: Story 2\nThe files it waited on are free and claimed for it\.$/,
  );
  assert.deepEqual(wakeWaiting(store, host), [], 'it wakes once');
});

test('two moons waiting on one file: the older one gets it, the other now waits on the older', async () => {
  const { store, host, recs, tools } = moonsOf(3);
  const [one, two, three] = tools;
  await one('claim_files', { paths: ['libs/a/y.ts'] });
  await two('claim_files', { paths: ['libs/a/y.ts'] });
  await three('claim_files', { paths: ['libs/a/y.ts'] });

  await one('report_to_pm', { stage: 'failed', summary: 'Gates red.' });
  assert.deepEqual(wakeWaiting(store, host), [recs[1].id]);
  assert.equal(store.get(recs[1].id)?.stage, 'starting', 'it had not planned yet');
  assert.equal(store.get(recs[2].id)?.stage, 'waiting');
  assert.deepEqual(store.get(recs[2].id)?.waitingOn, ['2']);
});

test('two moons that would wait on each other do not deadlock: the one closing the loop lets go of its files', async () => {
  const { store, host, recs, tools } = moonsOf(2);
  const [one, two] = tools;
  await one('claim_files', { paths: ['libs/a/a.ts'] });
  await two('claim_files', { paths: ['libs/b/b.ts'] });
  await one('claim_files', { paths: ['libs/b/b.ts'] });
  assert.deepEqual(store.get(recs[0].id)?.files, ['libs/a/a.ts'], 'the first to wait keeps its files');

  const loop = await two('claim_files', { paths: ['libs/a/a.ts'] });
  assert.match(loop.content[0].text, /Story 1 is waiting on this one, so Orbit let go of the files this story held/);
  assert.deepEqual(store.get(recs[1].id)?.files, []);
  assert.deepEqual(store.get(recs[1].id)?.waitingFiles, ['libs/a/a.ts', 'libs/b/b.ts']);

  assert.deepEqual(wakeWaiting(store, host), [recs[0].id]);
  assert.deepEqual(store.get(recs[0].id)?.files, ['libs/a/a.ts', 'libs/b/b.ts']);
  await one('report_to_pm', { stage: 'pr-opened', summary: 'Opened.', pr: 1 });
  assert.deepEqual(wakeWaiting(store, host), [recs[1].id]);
  assert.deepEqual(store.get(recs[1].id)?.files, ['libs/a/a.ts', 'libs/b/b.ts']);
});

test('a waiting moon stopped by a restart is resumed on its own session when it wakes', async () => {
  const { store, host, recs, tools, sentTo } = moonsOf(2);
  const [one, two] = tools;
  await one('claim_files', { paths: ['libs/a/y.ts'] });
  await two('claim_files', { paths: ['libs/a/y.ts'] });
  host.sessions.set(recs[1].id, 'sid-2');

  await one('report_to_pm', { stage: 'pr-opened', summary: 'Opened.', pr: 1 });
  assert.deepEqual(wakeWaiting(store, host), [recs[1].id]);
  assert.deepEqual(host.resumed, [[recs[1].id, 'sid-2']]);
  assert.match(sentTo(recs[1].id)[0], /^The files you waited on are free/);
});

test('starting a finished story again reuses its moon: a live one gets the new brief, a stopped one resumes, and a moon that will not come up is an error', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const host = fakeHost();
  const call = callerFor(
    orbitServer(
      pmStoryTools(store, host, shop, { cap: 2, model: null, agent: 'story-manager', skill: 'story-engine' }),
    ),
  );
  const id = 'story-shop-100203';
  await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'first' });
  // It reported blocked and sits idle with its session open.
  store.update(id, {
    stage: 'blocked',
    files: ['libs/a/x.ts'],
    reports: [{ at: 1, stage: 'blocked', summary: 'AC contradicts legacy.' }],
  });

  const again = await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'Keep legacy.' });
  assert.equal(again.isError, undefined);
  assert.match(again.content[0].text, /^Started story 100203 again on its moon \(1 of 2 in flight\)/);
  assert.deepEqual(host.removed, []);
  assert.equal(host.added.length, 1, 'the same moon, not a new one');
  const rec = store.get(id)!;
  assert.equal(rec.stage, 'starting');
  assert.deepEqual(rec.files, []);
  assert.equal(rec.reports.length, 1, 'its history stays');
  const told = host.sent.filter((s) => s.laneId === id).map((s) => s.text);
  assert.equal(told.length, 1);
  assert.match(
    told[0],
    /^Storefront started this story again\. Your worktree, branch, and earlier reports still stand/,
  );
  assert.match(told[0], /The PM's brief:\nKeep legacy\.$/);

  // Orbit restarted since: the moon is stopped but has its session, so it resumes.
  store.update(id, { stage: 'failed' });
  host.live.delete(id);
  host.sessions.set(id, 'sid-1');
  await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'Try again.' });
  assert.deepEqual(host.resumed, [[id, 'sid-1']]);
  assert.equal(host.sent.filter((s) => s.laneId === id).length, 2);

  // A moon that does not come up is reported, not claimed as started.
  store.update(id, { stage: 'failed' });
  host.live.delete(id);
  host.dead.add(id);
  const dead = await call('start_story', { storyId: '100203', title: 'Delivery question', brief: 'x' });
  assert.equal(dead.isError, true);
  assert.match(dead.content[0].text, /^Story 100203's moon did not start/);
});

test('a PM tells a story in flight something: a live moon hears it, a stopped one resumes first, a finished one is refused', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const host = fakeHost();
  const call = callerFor(
    orbitServer(
      pmStoryTools(store, host, shop, { cap: 2, model: null, agent: 'story-manager', skill: 'story-engine' }),
    ),
  );
  const id = 'story-shop-100129';
  const toMoon = () => host.sent.filter((s) => s.laneId === id).map((s) => s.text);
  await call('start_story', { storyId: '100129', title: 'Email the cart form', brief: 'x' });

  const twice = await call('start_story', { storyId: '100129', title: 'Email the cart form', brief: 'x' });
  assert.match(twice.content[0].text, /To tell it something, use tell_story\.$/);

  const told = await call('tell_story', { storyId: '100129', message: ' Q37: archive only the gift note picture. ' });
  assert.equal(told.isError, undefined);
  assert.match(told.content[0].text, /^Sent to story 100129's moon\./);
  assert.deepEqual(toMoon(), ['Message from the Storefront PM:\nQ37: archive only the gift note picture.']);

  // A send the moon cannot take waits in the mail rather than being lost.
  host.busy.add(id);
  const queued = await call('tell_story', { storyId: '100129', message: 'Use the shared mailer.' });
  assert.match(queued.content[0].text, /^Queued for story 100129's moon/);
  assert.equal(store.pending(id).length, 1);
  host.busy.delete(id);
  assert.equal(deliverMail(store, host, id), 1);

  // Orbit restarted since: the moon is stopped but has its session, so it resumes to hear it.
  host.live.delete(id);
  host.sessions.set(id, 'sid-1');
  await call('tell_story', { storyId: '100129', message: 'Carry on.' });
  assert.deepEqual(host.resumed, [[id, 'sid-1']]);
  assert.equal(toMoon().at(-1), 'Message from the Storefront PM:\nCarry on.');

  // No session to resume: the message waits for the moon, and the PM is told it is not running.
  host.live.delete(id);
  host.sessions.delete(id);
  const asleep = await call('tell_story', { storyId: '100129', message: 'Still there?' });
  assert.match(asleep.content[0].text, /^Story 100129's moon is not running/);
  assert.equal(store.pending(id).length, 1);

  const empty = await call('tell_story', { storyId: '100129', message: '  ' });
  assert.equal(empty.isError, true);
  const unknown = await call('tell_story', { storyId: '1', message: 'Hi.' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /^Story 1 is not on one of your moons/);
  const cart = { id: 'cas', name: 'Cart', cwd: shop.cwd };
  const other = callerFor(
    orbitServer(
      pmStoryTools(store, host, cart, { cap: 2, model: null, agent: 'story-manager', skill: 'story-engine' }),
    ),
  );
  assert.equal((await other('tell_story', { storyId: '100129', message: 'Hi.' })).isError, true, "another PM's moon");

  store.update(id, { stage: 'blocked' });
  const done = await call('tell_story', { storyId: '100129', message: 'Q37 is answered.' });
  assert.equal(done.isError, true);
  assert.match(done.content[0].text, /^Story 100129 has finished \(blocked\).*start_story/);
});

test("an answer to a PM's question tagged with a story in flight reaches that story's moon too", () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const decisions = new DecisionStore(openDb(':memory:'), { now: () => 5 });
  const host = fakeHost();
  const id = storyLaneId('shop', '100129');
  store.add({ ...moonBase, id, storyId: '100129', title: 'Email the cart form' });
  host.live.add(id);
  const answered = (laneId: string, question: string, story?: string) => {
    const { decision } = decisions.add({ laneId, laneName: 'x', question, today: 'Only the gift note.', story });
    return decisions.answer(decision.id, 'Only the gift note picture.')!;
  };

  const tagged = answered('shop', 'Should the email archive the worksheet too?', '100129');
  assert.equal(forwardAnswer(store, host, tagged), true);
  assert.deepEqual(host.sent, [
    {
      laneId: id,
      text: 'Product answer Q1 (story 100129): Only the gift note picture.\nThe question was: Should the email archive the worksheet too?\nYour PM asked this one; Orbit passed the answer on.',
    },
  ]);

  assert.equal(forwardAnswer(store, host, answered('shop', 'Untagged?')), false);
  assert.equal(forwardAnswer(store, host, answered('shop', 'No moon for it?', '1')), false);
  assert.equal(forwardAnswer(store, host, answered(id, 'The moon asked it itself?', '100129')), false, 'no echo');
  assert.equal(forwardAnswer(store, host, answered('cas', 'Another PM asked it?', '100129')), false);
  assert.equal(host.sent.length, 1);

  // A stopped moon still in flight gets it when it runs again.
  host.live.delete(id);
  assert.equal(forwardAnswer(store, host, answered('shop', 'And the PDF name?', '100129')), true);
  assert.equal(store.pending(id).length, 1);

  // A finished story's moon is left alone; its PM has the answer.
  store.update(id, { stage: 'pr-opened', pr: 1 });
  assert.equal(forwardAnswer(store, host, answered('shop', 'And the subject line?', '100129')), false);
});

test('a database from before waiting moons gains the columns with nothing waiting', () => {
  const file = path.join(dir, 'v2', 'orbit.db');
  const db = openDb(file);
  db.exec(
    'ALTER TABLE stories DROP COLUMN waiting_on; ALTER TABLE stories DROP COLUMN waiting_files; PRAGMA user_version = 2;',
  );
  db.exec(
    "INSERT INTO stories (id, parent_id, story_id, stage, files, reports) VALUES ('story-shop-1', 'shop', '1', 'building', '[]', '[]')",
  );
  db.close();
  const rec = new StoryStore(openDb(file)).get('story-shop-1')!;
  assert.deepEqual(rec.waitingOn, []);
  assert.deepEqual(rec.waitingFiles, []);
});

test('the story kickoff names the configured skill and never says ADO', () => {
  const k = storyKickoff({
    storyId: 'ACME-12',
    title: 'Saved cards',
    parentName: 'Storefront',
    brief: 'Traps: none.',
    skill: 'my-plugin:story-engine',
  });
  assert.match(k, /^You are the story manager for story ACME-12: Saved cards\./);
  assert.match(k, /Run the my-plugin:story-engine skill\./);
  assert.doesNotMatch(k, /\bADO\b/);
});

test('start_story kicks the moon off with the skill its PM tools were given', async () => {
  const store = new StoryStore(openDb(':memory:'), { now: () => 5 });
  const host = fakeHost();
  const opts = { cap: 2, model: null, agent: STARTER.storyAgent, skill: STARTER.storySkill };
  const call = callerFor(orbitServer(pmStoryTools(store, host, shop, opts)));
  await call('start_story', { storyId: '45', title: 'Saved cards', brief: 'Traps: none.' });
  assert.equal(host.added[0].agent, 'orbit-starter:story-manager');
  assert.match(host.added[0].brief, /Run the orbit-starter:story-engine skill\./);
});

test('no tool a project or story lane gets says ADO', () => {
  const sink = {} as LaneSink;
  const store = new StoryStore(openDb(':memory:'));
  const decisions = new DecisionStore(openDb(':memory:'));
  const access: BoardAccess = { tracker: () => null, board: () => null, refresh: async () => {} };
  const opts = { cap: 2, model: null, agent: STARTER.storyAgent, skill: STARTER.storySkill };
  const tools = [
    ...laneTools(sink, { id: 'shop' }),
    boardTool(sink, { id: 'shop' }),
    ...decisionTools(decisions, { id: 'shop', name: 'Storefront' }),
    ...boardTools(access, { projectId: 'shop' }),
    ...pmStoryTools(store, fakeHost(), shop, opts),
    ...moonTools(store, fakeHost(), { id: 'story-shop-45' }),
  ] as Array<{ name: string; description: string; inputSchema: z.ZodRawShape }>;
  assert.ok(tools.length > 10, `${tools.length} tools`);
  for (const t of tools) {
    const schema = JSON.stringify(z.toJSONSchema(z.object(t.inputSchema), { unrepresentable: 'any' }));
    assert.doesNotMatch(`${t.description} ${schema}`, /\bADO\b/, t.name);
  }
});
