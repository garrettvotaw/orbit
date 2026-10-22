import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHost, type QueryFactory, type QueryLike } from '../src/main/session-host.ts';
import { AttentionQueue } from '../src/main/attention.ts';
import { TestSlots } from '../src/main/slots.ts';
import { PushableStream } from '../src/main/input-stream.ts';
import { laneRules } from '../src/main/lane-tools.ts';
import type { LaneConfig } from '../src/shared/types.ts';
import { AGENT_RETENTION_MS } from '../src/shared/types.ts';

const shop: LaneConfig = {
  kind: 'project',
  id: 'shop',
  name: 'Shop',
  agent: 'shop-pm',
  cwd: 'C:/tmp',
  ado: { org: 'o', project: 'p', anchorId: 1 },
  kickoff: 'Run the Shop board.',
};
const prs: LaneConfig = {
  kind: 'monitor',
  id: 'prs',
  name: 'PRs',
  skill: 'monitor-prs',
  cwd: 'C:/tmp',
  everyMinutes: 20,
  stateFile: 'x',
};

type ToolFn = (
  t: string,
  i: Record<string, unknown>,
  o: { signal: AbortSignal; toolUseID: string },
) => Promise<Record<string, unknown>>;

/** A fake query: records options, lets the test feed messages and read what the host pushed. */
function fakeQuery() {
  const calls: Array<{
    options: Record<string, unknown>;
    prompt: AsyncIterable<unknown>;
    out: PushableStream<unknown>;
    sent: unknown[];
    closed: boolean;
    interrupted: boolean;
  }> = [];
  const factory: QueryFactory = ({ prompt, options }) => {
    const out = new PushableStream<unknown>();
    const call = { options, prompt, out, sent: [] as unknown[], closed: false, interrupted: false };
    calls.push(call);
    void (async () => {
      for await (const m of prompt) call.sent.push(m);
    })();
    const q: QueryLike = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => {
        call.interrupted = true;
      },
      close: () => {
        call.closed = true;
        out.end();
      },
    };
    return q;
  };
  return { factory, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('start builds the documented options and pushes the kickoff', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  const o = calls[0].options;
  assert.equal(o.agent, 'shop-pm');
  assert.equal(o.cwd, 'C:/tmp');
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, true);
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: laneRules('project') });
  assert.deepEqual(o.tools, { type: 'preset', preset: 'claude_code' });
  assert.equal(o.agentProgressSummaries, true);
  assert.equal((o.env as Record<string, string>).ORBIT_LANE, 'shop');
  assert.equal((o.env as Record<string, string>).PATH, process.env.PATH);
  assert.equal(typeof o.canUseTool, 'function');
  assert.equal((calls[0].sent[0] as { message: { content: string } }).message.content, 'Run the Shop board.');
  assert.equal(host.snapshot().lanes[0].status, 'starting');
});

test('monitor lanes omit agent and get the tick kickoff', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([prs]);
  host.start('prs');
  await tick();
  assert.equal(calls[0].options.agent, undefined);
  assert.match(
    (calls[0].sent[0] as { message: { content: string } }).message.content,
    /monitor-prs[\s\S]*Do not arm a cron[\s\S]*ask_product_owner/,
  );
});

test('messages flow through the reducer into the snapshot', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  calls[0].out.push({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', uuid: 'u' });
  await tick();
  assert.equal(host.snapshot().lanes[0].sessionId, 's1');
  assert.equal(host.snapshot().lanes[0].status, 'working');
});

test('second start while live is a no-op', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.start('shop');
  host.start('shop');
  await tick();
  assert.equal(calls.length, 1);
});

test('AskUserQuestion round-trips through the attention queue; other tools are allowed', async () => {
  const { factory, calls } = fakeQuery();
  const attention = new AttentionQueue();
  const host = new SessionHost({ query: factory, attention });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  const canUseTool = calls[0].options.canUseTool as ToolFn;
  const bash = await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'x' });
  assert.deepEqual(bash, { behavior: 'allow', updatedInput: { command: 'ls' } });
  const questions = [
    {
      question: 'Q?',
      header: 'H',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      multiSelect: false,
    },
  ];
  const p = canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'tu1' });
  await tick();
  const item = attention.items()[0];
  assert.equal(item.kind, 'question');
  attention.answer(item.id, { 'Q?': 'B' });
  assert.deepEqual(await p, { behavior: 'allow', updatedInput: { questions, answers: { 'Q?': 'B' } } });
  const noted = canUseTool(
    'AskUserQuestion',
    { questions },
    { signal: new AbortController().signal, toolUseID: 'tu2' },
  );
  await tick();
  attention.answer(attention.items()[0].id, { 'Q?': 'A' }, { 'Q?': { preview: 'a mockup', notes: 'tighter' } });
  assert.deepEqual(await noted, {
    behavior: 'allow',
    updatedInput: {
      questions,
      answers: { 'Q?': 'A' },
      annotations: { 'Q?': { preview: 'a mockup', notes: 'tighter' } },
    },
  });
});

test('send pushes a user message with priority', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  assert.equal(host.send('shop', 'skip 100107', 'now'), true);
  await tick();
  const m = calls[0].sent[1] as { type: string; priority: string; message: { role: string; content: string } };
  assert.equal(m.type, 'user');
  assert.equal(m.priority, 'now');
  assert.equal(m.message.content, 'skip 100107');
  assert.equal(host.send('prs', 'x', 'next'), false, 'unknown or stopped lane');
});

test('send carries screenshots as image blocks ahead of the words, and the feed notes them', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  const shot = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  assert.equal(host.send('shop', 'this toast never clears', 'next', [shot, shot]), true);
  await tick();
  const m = calls[0].sent[1] as { message: { content: Array<{ type: string }> } };
  assert.deepEqual(
    m.message.content.map((b) => b.type),
    ['image', 'image', 'text'],
  );
  assert.equal(host.feed('shop').at(-1)?.text, 'this toast never clears\n[2 screenshots]');
});

test('stop interrupts, closes, and marks stopped; open questions are cleared', async () => {
  const { factory, calls } = fakeQuery();
  const attention = new AttentionQueue();
  const host = new SessionHost({ query: factory, attention });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  const canUseTool = calls[0].options.canUseTool as ToolFn;
  const q = canUseTool('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 't' });
  await tick();
  await host.stop('shop');
  assert.equal(calls[0].interrupted, true);
  assert.equal(calls[0].closed, true);
  assert.equal(host.snapshot().lanes[0].status, 'stopped');
  const settled = (await q) as { behavior: string; message?: string };
  assert.equal(settled.behavior, 'deny', 'an unanswered question is denied, never answered');
  assert.match(settled.message ?? '', /stopped before this question was answered/);
  assert.equal(attention.items().length, 0);
});

test('resume passes resume: sessionId and the resume prompt', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.resume('shop', 'old-sess');
  await tick();
  assert.equal(calls[0].options.resume, 'old-sess');
  assert.match((calls[0].sent[0] as { message: { content: string } }).message.content, /You were interrupted/);
});

test('a resumed story moon is told to pick its story back up, not to run a board', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.addTransient({
    kind: 'story',
    id: 'story-shop-100233',
    name: '100233 · Coupon pick',
    cwd: 'C:/tmp',
    parentId: 'shop',
    storyId: '100233',
    title: 'Coupon pick',
    brief: 'go',
    agent: 'story-manager',
  });
  host.resume('story-shop-100233', 'moon-sess');
  host.resume('shop', 'pm-sess');
  await tick();
  const sent = (i: number) => (calls[i].sent[0] as { message: { content: string } }).message.content;
  assert.equal(calls[0].options.resume, 'moon-sess');
  assert.match(sent(0), /You were interrupted/);
  assert.match(sent(0), /story/);
  assert.doesNotMatch(sent(0), /board/, 'a moon has no board');
  assert.match(sent(1), /Re-derive the board/, 'the PM still re-derives its board');
});

test('error result raises attention with a code; api errors auto-resume once after 60s', async () => {
  const { factory, calls } = fakeQuery();
  const attention = new AttentionQueue();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const fakeTimeout = ((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  const host = new SessionHost({ query: factory, attention, setTimeout: fakeTimeout });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  calls[0].out.push({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', uuid: 'u' });
  calls[0].out.push({
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['503 from Bedrock'],
    total_cost_usd: 1,
    uuid: 'u',
  });
  calls[0].out.end();
  await tick();
  await tick();
  assert.equal(host.snapshot().lanes[0].status, 'error');
  assert.equal(attention.items().length, 0, 'first api error is retried silently');
  assert.equal(timers[0].ms, 60_000);
  timers[0].fn();
  await tick();
  assert.equal(calls.length, 2, 'auto-resumed');
  assert.equal(calls[1].options.resume, 's1');
  calls[1].out.push({
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['503 again'],
    total_cost_usd: 1,
    uuid: 'u',
  });
  calls[1].out.end();
  await tick();
  await tick();
  assert.equal(attention.items()[0].kind, 'error');
  assert.equal((attention.items()[0] as { code: string }).code, 'api');
});

test('generator throwing marks the lane error with exit code', async () => {
  const factory: QueryFactory = () => ({
    [Symbol.asyncIterator]: async function* () {
      throw new Error('Claude Code process exited with code 1');
    },
    interrupt: async () => {},
    close: () => {},
  });
  const attention = new AttentionQueue();
  const host = new SessionHost({ query: factory, attention });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  await tick();
  assert.equal(host.snapshot().lanes[0].status, 'error');
  assert.equal((attention.items()[0] as { code: string }).code, 'exit');
});

test('agents still working when the CLI exits are marked stopped', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), now: () => 7 });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  calls[0].out.push({
    type: 'system',
    subtype: 'task_started',
    task_id: 'a1',
    description: 'QA lane V',
    subagent_type: 'qa-tester',
    task_type: 'local_agent',
    is_backgrounded: false,
    uuid: 'u',
  });
  await tick();
  calls[0].out.end();
  await tick();
  await tick();
  const l = host.snapshot().lanes[0];
  assert.equal(l.status, 'stopped');
  assert.equal(l.agents[0].state, 'stopped');
  assert.equal(l.agents[0].endedAt, 7);
});

test('hydrate restores sessionId and cost but not liveness', () => {
  const host = new SessionHost({ query: fakeQuery().factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.hydrate([{ id: 'shop', sessionId: 'old', status: 'working', startedAt: 5, costUsd: 2 }]);
  const l = host.snapshot().lanes[0];
  assert.equal(l.sessionId, 'old');
  assert.equal(l.costUsd, 2);
  assert.equal(l.status, 'stopped');
  assert.equal(host.isLive('shop'), false);
});

test('sweep drops finished agents on a quiet lane and emits only when something changed', async () => {
  const { factory, calls } = fakeQuery();
  let now = 1_000;
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), now: () => now });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  calls[0].out.push({
    type: 'system',
    subtype: 'task_started',
    task_id: 'a1',
    description: 'x',
    task_type: 'local_agent',
    uuid: 'u',
  });
  calls[0].out.push({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'a1',
    status: 'completed',
    summary: 's',
    uuid: 'u',
  });
  await tick();
  assert.equal(host.snapshot().lanes[0].agents.length, 1);
  let emits = 0;
  host.onChange(() => emits++);
  host.sweep();
  assert.equal(emits, 0, 'nothing to prune yet');
  now += AGENT_RETENTION_MS + 1;
  host.sweep();
  assert.equal(emits, 1);
  assert.equal(host.snapshot().lanes[0].agents.length, 0);
});

const chat: LaneConfig = { kind: 'chat', id: 'ask', name: 'Ask', cwd: 'C:/tmp', model: 'sonnet' };

test('a chat lane starts idle with no kickoff, carries its model, and feeds what you send', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([chat]);
  host.start('ask');
  await tick();
  assert.equal(calls[0].sent.length, 0, 'nothing pushed until you speak');
  assert.equal(calls[0].options.model, 'sonnet');
  assert.equal(calls[0].options.agent, undefined);
  assert.deepEqual(
    calls[0].options.systemPrompt,
    { type: 'preset', preset: 'claude_code' },
    'a chat gets no Orbit rules',
  );
  assert.equal(host.snapshot().lanes[0].status, 'idle');
  assert.equal(host.snapshot().lanes[0].requestedModel, 'sonnet');

  host.send('ask', 'hello there', 'next');
  calls[0].out.push({
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'us.anthropic.claude-sonnet-5-5',
    uuid: 'u',
  });
  calls[0].out.push({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hi Pat.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/x/README.md' } },
      ],
    },
    parent_tool_use_id: null,
    uuid: 'u',
  });
  calls[0].out.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '# Orbit' }] },
    parent_tool_use_id: null,
    uuid: 'u',
  });
  calls[0].out.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'inner agent text' }] },
    parent_tool_use_id: 'sub',
    uuid: 'u',
  });
  await tick();
  assert.deepEqual(
    host.feed('ask').map((e) => [e.kind, e.text]),
    [
      ['user', 'hello there'],
      ['text', 'Hi Pat.'],
      ['tool', 'Read README.md'],
      ['result', '# Orbit'],
    ],
  );
  assert.equal(host.snapshot().lanes[0].feedCount, 4);
});

test('setModel switches a live session and remembers the choice for the next start', async () => {
  const { factory, calls } = fakeQuery();
  const setCalls: Array<string | undefined> = [];
  const withSetModel: QueryFactory = (args) => {
    const q = factory(args);
    q.setModel = async (m) => {
      setCalls.push(m);
    };
    q.supportedModels = async () => [{ value: 'opus', displayName: 'Opus' }];
    return q;
  };
  const host = new SessionHost({ query: withSetModel, attention: new AttentionQueue() });
  host.setLanes([shop]);
  assert.equal(await host.models(), null, 'no live session yet');
  host.start('shop');
  await tick();
  calls[0].out.push({ type: 'system', subtype: 'init', session_id: 's1', model: 'fable', uuid: 'u' });
  await tick();
  await host.setModel('shop', 'opus');
  assert.deepEqual(setCalls, ['opus']);
  assert.equal(host.snapshot().lanes[0].model, 'opus');
  assert.equal(host.snapshot().lanes[0].requestedModel, 'opus');
  assert.deepEqual(await host.models(), [{ value: 'opus', label: 'Opus' }]);

  await host.stop('shop');
  host.start('shop');
  await tick();
  assert.equal(calls[1].options.model, 'opus', 'the chosen model survives a restart');
  await host.setModel('shop', null);
  assert.deepEqual(setCalls, ['opus', undefined]);
});

test('transient review lanes survive config reloads, kick off the skill, and leave when stopped', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  const review: LaneConfig = {
    kind: 'review',
    id: 'review-7127',
    name: '#7127 review',
    cwd: 'C:/tmp',
    pr: 7127,
    repo: 'o/r',
    url: 'https://github.com/o/r/pull/7127',
  };
  assert.equal(host.addTransient(review), true);
  assert.equal(host.addTransient(review), false, 'same id twice is refused');
  assert.deepEqual(
    host.snapshot().lanes.map((l) => l.id),
    ['shop', 'review-7127'],
  );
  assert.deepEqual(host.snapshot().lanes[1].pr, { number: 7127, url: 'https://github.com/o/r/pull/7127' });

  host.setLanes([shop]);
  assert.equal(host.snapshot().lanes.length, 2, 'config reload keeps the transient lane');

  host.start('review-7127');
  await tick();
  assert.equal((calls[0].sent[0] as { message: { content: string } }).message.content, '/orbit-starter:review-pr 7127');
  assert.equal(calls[0].options.agent, undefined);
  assert.equal(host.removeTransient('review-7127'), false, 'live lanes stay');
  await host.stop('review-7127');
  assert.equal(host.removeTransient('review-7127'), true);
  assert.deepEqual(
    host.snapshot().lanes.map((l) => l.id),
    ['shop'],
  );
  assert.equal(host.removeTransient('shop'), false, 'config lanes are not transient');
});

test('stop waits for the process to end before settling a pending question', async () => {
  const { factory, calls } = fakeQuery();
  const attention = new AttentionQueue();
  const host = new SessionHost({ query: factory, attention });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  // A CLI that ignores close() and keeps running until it is killed.
  calls[0].out.end = () => {};
  const canUseTool = calls[0].options.canUseTool as ToolFn;
  let settledAt: 'before-exit' | 'after-exit' | null = null;
  const q = canUseTool(
    'AskUserQuestion',
    { questions: [] },
    { signal: new AbortController().signal, toolUseID: 't' },
  ).then(() => {
    settledAt = settledAt ?? 'before-exit';
  });
  await tick();
  const stopping = host.stop('shop');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settledAt, null, 'still pending while the process lives');
  assert.equal(attention.items().length, 1, 'the question is still on the beacon');
  // Now the process dies: the pump drains and stop() may settle the question.
  const iterator = calls[0].out[Symbol.asyncIterator]();
  void iterator;
  PushableStream.prototype.end.call(calls[0].out);
  await stopping;
  await q;
  settledAt = settledAt ?? 'after-exit';
  assert.equal(attention.items().length, 0);
  assert.equal(host.snapshot().lanes[0].status, 'stopped');
});

test('a lane stays needs-you while a question is open even if the CLI reports running', async () => {
  const { factory, calls } = fakeQuery();
  const attention = new AttentionQueue();
  const host = new SessionHost({ query: factory, attention });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  const canUseTool = calls[0].options.canUseTool as ToolFn;
  const p = canUseTool('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 't' });
  await tick();
  assert.equal(host.snapshot().lanes[0].status, 'needs-you');
  calls[0].out.push({ type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'u' });
  await tick();
  assert.equal(host.snapshot().lanes[0].status, 'needs-you', 'state chatter does not hide your turn');
  attention.answer(attention.items()[0].id, {});
  await p;
  assert.equal(host.snapshot().lanes[0].status, 'working');
});
test('a review waits on you only through review_preview, replying clears it, and results keep their tool name', async () => {
  const { factory, calls } = fakeQuery();
  const attention = new AttentionQueue();
  const host = new SessionHost({ query: factory, attention });
  host.setLanes([shop]);
  host.addTransient({ kind: 'review', id: 'review-7', name: '#7 review', cwd: 'C:/tmp', pr: 7, repo: 'o/r', url: 'u' });
  host.start('review-7');
  await tick();
  calls[0].out.push({ type: 'system', subtype: 'init', session_id: 's', model: 'm', uuid: 'u' });
  calls[0].out.push({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'gh pr diff 7' } }],
    },
    parent_tool_use_id: null,
    uuid: 'u',
  });
  calls[0].out.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'diff --git' }] },
    parent_tool_use_id: null,
    uuid: 'u',
  });
  calls[0].out.push({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'PR #7 looks clean. Approve, request changes, or leave as-is? (a/r/leave)' }],
    },
    parent_tool_use_id: null,
    uuid: 'u',
  });
  calls[0].out.push({ type: 'result', subtype: 'success', total_cost_usd: 0.5, result: 'x', uuid: 'u' });
  await tick();
  const feed = host.feed('review-7');
  assert.equal(
    feed.find((e) => e.kind === 'result')!.tool,
    'Bash',
    'the result remembers its tool across stream messages',
  );
  assert.equal(attention.items().length, 0, 'a question in the reply text is not read');

  const finding = { n: 1, severity: 'major' as const, file: 'a.ts', line: 4, gist: 'Runs after the ERP call.' };
  host.reviewPreview('review-7', { findings: [finding] });
  const items = attention.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'blocked');
  assert.equal((items[0] as { story: string }).story, '#7');
  const review = () => host.snapshot().lanes.find((l) => l.id === 'review-7')!;
  assert.deepEqual(review().reviewPrompt, { findings: [finding] });
  // Orbit posts it itself: GitHub refusing keeps the preview for Claude to take over...
  const refused = { ok: false, at: 1, pick: 'approve', error: 'gh: HTTP 422' } as const;
  host.reviewPosted('review-7', refused);
  assert.deepEqual(review().reviewResult, refused);
  assert.deepEqual(review().reviewPrompt, { findings: [finding] }, 'kept for Claude');
  assert.equal(attention.items().length, 1, 'still waiting on you');
  // ...and a posted review clears the preview and the nudge.
  const posted = { ok: true, at: 2, event: 'APPROVE', comments: 1, url: 'u#review' } as const;
  host.reviewPosted('review-7', posted);
  assert.deepEqual(review().reviewResult, posted);
  assert.equal(review().reviewPrompt, null);
  assert.equal(attention.items().length, 0);
  host.reviewPreview('review-7', { findings: [finding] });
  assert.equal(review().reviewResult, null, 'a new preview starts over');
  host.send('review-7', 'Post all comments. Approve.', 'next');
  assert.equal(attention.items().length, 0, 'replying clears the nudge');
  assert.equal(review().reviewPrompt, null, 'and the preview');
});

test('finished turns teach model prices and add their growth to today, which hydrate restores', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([shop]);
  host.hydrate([{ id: 'shop', sessionId: 's1', status: 'stopped', startedAt: 1, costUsd: 2 }]);
  host.hydrateAccounting({ spent: { day: '1999-01-01', usd: 50 } });
  assert.equal(host.snapshot().spentTodayUsd, 0, 'another day is not today');
  host.resume('shop', 's1');
  await tick();
  const usage = {
    inputTokens: 1000,
    outputTokens: 19,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 192000,
    costUSD: 0.96438,
    canonicalModel: 'claude-opus-5-5',
    costBasis: 'list',
  };
  calls[0].out.push({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 2.75,
    result: 'ok',
    modelUsage: { 'us.anthropic.claude-opus-5-5': usage },
  });
  await tick();
  assert.ok(Math.abs(host.snapshot().spentTodayUsd - 0.75) < 1e-9, 'the resumed session grew by 0.75');
  assert.ok(Math.abs(host.accounting().rates['claude-opus-5-5'].perWeighted - 4e-6) < 1e-12);
  calls[0].out.push({ type: 'result', subtype: 'success', total_cost_usd: 2.5, result: 'ok' });
  await tick();
  assert.ok(Math.abs(host.snapshot().spentTodayUsd - 0.75) < 1e-9, 'a total that went down adds nothing');
  const again = new SessionHost({ query: factory, attention: new AttentionQueue() });
  again.setLanes([shop]);
  again.hydrateAccounting(host.accounting());
  assert.ok(Math.abs(again.snapshot().spentTodayUsd - 0.75) < 1e-9);
  assert.ok(again.accounting().rates['us.anthropic.claude-opus-5-5']);
});

test('a lane stops for your word only through needs_you, and the ask outlives its turns until you reply or it withdraws', async () => {
  const { factory, calls } = fakeQuery();
  const attention = new AttentionQueue();
  const host = new SessionHost({ query: factory, attention });
  host.setLanes([shop, prs]);
  host.start('shop');
  await tick();
  const say = (i: number, text: string) =>
    calls[i].out.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      uuid: 'u',
    });
  const finish = (i: number, result: string) =>
    calls[i].out.push({ type: 'result', subtype: 'success', total_cost_usd: 1, result, uuid: 'u' });
  calls[0].out.push({ type: 'system', subtype: 'init', session_id: 's', model: 'm', uuid: 'u' });

  const question =
    'Which should the delivery form send?\n\n1. **StoreCode** — the old code\n2. **BranchCode** — what ERP expects';
  say(0, question);
  finish(0, question);
  const report = '## Blocked\n- 100204 needs a decision on the N/A pad';
  say(0, report);
  finish(0, report);
  await tick();
  assert.equal(attention.items().length, 0, 'neither a question nor a Blocked row in the text nudges');

  host.needsYou('shop', {
    question: 'Which should the delivery form send?',
    options: ['StoreCode', 'BranchCode'],
    story: null,
  });
  let items = attention.items();
  assert.equal(items.length, 1);
  const ask = items[0] as { kind: string; story: string; decision: string; text: string | null; options: unknown };
  assert.equal(ask.kind, 'blocked');
  assert.equal(ask.story, 'your answer');
  assert.equal(ask.text, 'Which should the delivery form send?');
  assert.deepEqual(ask.options, [
    { label: 'StoreCode', reply: 'StoreCode' },
    { label: 'BranchCode', reply: 'BranchCode' },
  ]);
  finish(0, 'Board derived. Two lanes building.');
  await tick();
  assert.equal(attention.items().length, 1, 'a later turn does not clear an open ask');

  host.needsYou('shop', { question: 'Close the nine that passed QA?', options: [], story: '100204' });
  items = attention.items();
  assert.equal(items.length, 1, 'a new ask replaces the old one');
  assert.equal((items[0] as { story: string }).story, '100204');
  host.send('shop', 'Close them.', 'next');
  assert.equal(attention.items().length, 0, 'answering clears it');

  host.needsYou('shop', { question: 'Merge #7123?', options: [], story: null });
  assert.equal(host.withdrawNeedsYou('shop'), true);
  assert.equal(attention.items().length, 0, 'the lane can take it back');
  assert.equal(host.withdrawNeedsYou('shop'), false, 'and says so when nothing was open');

  host.start('prs');
  await tick();
  calls[1].out.push({ type: 'system', subtype: 'init', session_id: 's2', model: 'm', uuid: 'u' });
  say(1, 'resolveReviewThread was refused on #7123; only you can clear those threads.');
  finish(1, 'x');
  await tick();
  assert.equal(attention.items().length, 0, 'a monitor that only says so in text does not nudge');
});

test('post_status sets the line under the core and its bubble; report_board stamps the board; PM text says neither', async () => {
  const { factory, calls } = fakeQuery();
  let now = 100;
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), now: () => now });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  calls[0].out.push({ type: 'system', subtype: 'init', session_id: 's', model: 'm', uuid: 'u' });
  calls[0].out.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '## Board\nShipped one, two building.' }] },
    parent_tool_use_id: null,
    uuid: 'u',
  });
  calls[0].out.push({ type: 'result', subtype: 'success', total_cost_usd: 1, result: '## Shipped\n- 1 a', uuid: 'u' });
  await tick();
  let lane = host.snapshot().lanes[0];
  assert.equal(lane.lastSummary, null, 'reply text is not read for a status');
  assert.equal(lane.bubble, null);
  assert.equal(lane.lastReport, null, 'nor for a board');

  now = 200;
  host.postStatus('shop', 'Coupon-pick PR is up, two building.');
  const board = { shipped: ['100233 coupon pick'], inFlight: [], consults: [], drift: [], blocked: [], next: null };
  host.reportBoard('shop', board);
  lane = host.snapshot().lanes[0];
  assert.equal(lane.lastSummary, 'Coupon-pick PR is up, two building.');
  assert.deepEqual(lane.bubble, {
    kind: 'said',
    text: 'Coupon-pick PR is up, two building.',
    agentType: null,
    at: 200,
  });
  assert.deepEqual(lane.lastReport, { ...board, at: 200 });
});

test('a PM session gets the MCP servers toolsFor hands it; chats and reviews do not', async () => {
  const { factory, calls } = fakeQuery();
  const given: string[] = [];
  const host = new SessionHost({
    query: factory,
    attention: new AttentionQueue(),
    toolsFor: (cfg) => {
      given.push(cfg.id);
      return cfg.kind === 'project' ? { orbit: { type: 'sdk', name: 'orbit' } } : null;
    },
  });
  host.setLanes([shop, chat]);
  host.start('shop');
  host.start('ask');
  await tick();
  assert.deepEqual(given, ['shop', 'ask']);
  assert.deepEqual(calls[0].options.mcpServers, { orbit: { type: 'sdk', name: 'orbit' } });
  assert.equal('mcpServers' in calls[1].options, false);
});

type Hook = (input: Record<string, unknown>, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;
const hook = (options: Record<string, unknown>, event: string): Hook =>
  (options.hooks as Record<string, Array<{ hooks: Hook[] }>>)[event][0].hooks[0];
const bash = (toolUseId: string, command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_use_id: toolUseId,
  tool_input: { command, ...extra },
});
const free = () => new AbortController().signal;
function settled(p: Promise<unknown>) {
  const w = { done: false, value: undefined as unknown };
  void p.then((v) => {
    w.done = true;
    w.value = v;
  });
  return w;
}

test('a heavy Bash waits for a slot and runs when the holder finishes', async () => {
  const { factory, calls } = fakeQuery();
  const slots = new TestSlots({ base: 1 });
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), slots });
  host.setLanes([shop, prs]);
  host.start('shop');
  host.start('prs');
  await tick();
  const first = await hook(calls[0].options, 'PreToolUse')(bash('t1', 'npx nx test a'), 't1', { signal: free() });
  assert.deepEqual(first, {});
  const second = settled(
    hook(calls[1].options, 'PreToolUse')(bash('t2', 'npx nx affected -t test'), 't2', { signal: free() }),
  );
  await tick();
  assert.equal(second.done, false);
  assert.equal(host.lane('prs')?.bubble?.text, '⏳ waiting for a test slot');
  assert.equal(host.lane('shop')?.bubble, null, 'a command that got its slot at once says nothing');
  await hook(calls[0].options, 'PostToolUse')({ hook_event_name: 'PostToolUse', tool_use_id: 't1' }, 't1', {
    signal: free(),
  });
  await tick();
  assert.equal(second.done, true);
  assert.deepEqual(
    slots.view().slots.map((s) => [s.laneId, s.label]),
    [['prs', 'nx affected']],
  );
});

test('a light Bash passes straight through', async () => {
  const { factory, calls } = fakeQuery();
  const slots = new TestSlots({ base: 0 });
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), slots });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  assert.deepEqual(await hook(calls[0].options, 'PreToolUse')(bash('t1', 'git status'), 't1', { signal: free() }), {});
  assert.deepEqual(slots.view(), { slots: [], waiting: [] });
});

test('a subagent’s heavy Bash queues under its lane', async () => {
  const { factory, calls } = fakeQuery();
  const slots = new TestSlots({ base: 1 });
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), slots });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  await hook(calls[0].options, 'PreToolUse')({ ...bash('t1', 'npx jest x'), agent_id: 'a1' }, 't1', {
    signal: free(),
  });
  assert.deepEqual(
    slots.view().slots.map((s) => [s.laneId, s.agentId, s.label]),
    [['shop', 'a1', 'jest']],
  );
});

test('stopping a lane that holds a slot kills its tree and frees the slot', async () => {
  const { factory, calls } = fakeQuery();
  const slots = new TestSlots({ base: 1 });
  const killed: string[] = [];
  const host = new SessionHost({
    query: factory,
    attention: new AttentionQueue(),
    slots,
    killLane: (id) => killed.push(id),
  });
  host.setLanes([shop, prs]);
  host.start('shop');
  host.start('prs');
  await tick();
  await hook(calls[0].options, 'PreToolUse')(bash('t1', 'npx nx test a'), 't1', { signal: free() });
  await host.stop('prs');
  assert.deepEqual(killed, [], 'a lane with no slot is not killed');
  await host.stop('shop');
  assert.deepEqual(killed, ['shop']);
  assert.equal(slots.holds('shop'), false);
});

test('task_notification frees a background slot', async () => {
  const { factory, calls } = fakeQuery();
  const slots = new TestSlots({ base: 1 });
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), slots });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  await hook(calls[0].options, 'PreToolUse')(bash('t1', 'npm run e2e', { run_in_background: true }), 't1', {
    signal: free(),
  });
  calls[0].out.push({
    type: 'system',
    subtype: 'task_started',
    task_id: 'k1',
    tool_use_id: 't1',
    description: 'e2e',
    is_backgrounded: true,
  });
  await hook(calls[0].options, 'PostToolUse')({ hook_event_name: 'PostToolUse', tool_use_id: 't1' }, 't1', {
    signal: free(),
  });
  await tick();
  assert.equal(slots.holds('shop'), true, 'PostToolUse right after launch does not free it');
  calls[0].out.push({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'k1',
    tool_use_id: 't1',
    status: 'completed',
    output_file: 'x',
    summary: 'done',
  });
  await tick();
  assert.equal(slots.holds('shop'), false);
});

test('startWhenRoom parks while admit is false and releaseHeld launches it', async () => {
  const { factory, calls } = fakeQuery();
  let room = false;
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), admit: () => room });
  host.setLanes([shop]);
  host.startWhenRoom('shop');
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(host.isHeld('shop'), true);
  assert.deepEqual(
    host.heldView().map((w) => [w.laneId, w.label, w.reason, w.kind]),
    [['shop', 'moon start', 'memory', 'launch']],
  );
  assert.equal(host.releaseHeld(), null, 'still no room');
  room = true;
  assert.equal(host.releaseHeld(), 'shop');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(host.isHeld('shop'), false);
});

test('start by hand launches a held lane right away', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), admit: () => false });
  host.setLanes([shop]);
  host.resumeWhenRoom('shop', 's1');
  host.start('shop');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(host.isHeld('shop'), false);
});

test('api-error auto-resume waits for room', async () => {
  const { factory, calls } = fakeQuery();
  const timers: Array<() => void> = [];
  const fakeTimeout = ((fn: () => void) => {
    timers.push(fn);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  let room = true;
  const host = new SessionHost({
    query: factory,
    attention: new AttentionQueue(),
    setTimeout: fakeTimeout,
    admit: () => room,
  });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  calls[0].out.push({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', uuid: 'u' });
  calls[0].out.push({
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['503'],
    total_cost_usd: 1,
    uuid: 'u',
  });
  calls[0].out.end();
  await tick();
  await tick();
  room = false;
  timers[0]();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(host.isHeld('shop'), true);
});

test('a foreground gate the CLI backgrounds keeps its slot when PostToolUse arrives before any task message', async () => {
  const { factory, calls } = fakeQuery();
  const slots = new TestSlots({ base: 1 });
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), slots });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  await hook(calls[0].options, 'PreToolUse')(bash('t1', 'npx nx affected -t test'), 't1', { signal: free() });
  await hook(calls[0].options, 'PostToolUse')(
    {
      hook_event_name: 'PostToolUse',
      tool_use_id: 't1',
      tool_response: { backgroundTaskId: 'k1', timedOutAfterMs: 120_000 },
    },
    't1',
    { signal: free() },
  );
  assert.equal(slots.holds('shop'), true, 'auto-backgrounded at its timeout, still running');
  calls[0].out.push({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'k1',
    status: 'completed',
    output_file: 'x',
    summary: 'done',
  });
  await tick();
  assert.equal(slots.holds('shop'), false, 'freed by its task id alone');
});

test('a stop kills the tree of a lane that held a slot even when the interrupt frees it first', async () => {
  const { factory, calls } = fakeQuery();
  // The CLI answers an interrupt with PostToolUseFailure for the running command.
  const interrupting: QueryFactory = (args) => {
    const q = factory(args);
    const interrupt = q.interrupt.bind(q);
    q.interrupt = async () => {
      await hook(args.options, 'PostToolUseFailure')(
        { hook_event_name: 'PostToolUseFailure', tool_use_id: 't1' },
        't1',
        {
          signal: free(),
        },
      );
      return interrupt();
    };
    return q;
  };
  const slots = new TestSlots({ base: 1 });
  const killed: string[] = [];
  const host = new SessionHost({
    query: interrupting,
    attention: new AttentionQueue(),
    slots,
    killLane: (id) => killed.push(id),
  });
  host.setLanes([shop]);
  host.start('shop');
  await tick();
  await hook(calls[0].options, 'PreToolUse')(bash('t1', 'npx nx test a'), 't1', { signal: free() });
  await host.stop('shop');
  assert.deepEqual(killed, ['shop']);
});

test('the waiting bubble goes once the command gets its slot', async () => {
  const { factory, calls } = fakeQuery();
  const slots = new TestSlots({ base: 1 });
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), slots });
  host.setLanes([shop, prs]);
  host.start('shop');
  host.start('prs');
  await tick();
  await hook(calls[0].options, 'PreToolUse')(bash('t1', 'npx nx test a'), 't1', { signal: free() });
  const second = hook(calls[1].options, 'PreToolUse')(bash('t2', 'npx jest'), 't2', { signal: free() });
  await tick();
  assert.equal(host.lane('prs')?.bubble?.text, '⏳ waiting for a test slot');
  await hook(calls[0].options, 'PostToolUse')({ hook_event_name: 'PostToolUse', tool_use_id: 't1' }, 't1', {
    signal: free(),
  });
  await second;
  assert.equal(host.lane('prs')?.bubble, null);
});

test('a review lane kicks off the review skill from config', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue(), reviewSkill: () => 'review-pr' });
  host.addTransient({
    kind: 'review',
    id: 'review-41',
    name: '#41 review',
    cwd: 'C:/tmp',
    pr: 41,
    repo: 'o/r',
    url: 'https://github.com/o/r/pull/41',
  });
  host.start('review-41');
  await tick();
  assert.equal((calls[0].sent[0] as { message: { content: string } }).message.content, '/review-pr 41');
  await host.stop('review-41');
});

test('a lane gets the Nx env only when its folder has an nx.json', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'orbit-plain-'));
  const nx = mkdtempSync(join(tmpdir(), 'orbit-nx-'));
  try {
    writeFileSync(join(nx, 'nx.json'), '{}');
    const { factory, calls } = fakeQuery();
    const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
    host.setLanes([
      { ...shop, cwd: plain },
      { ...shop, id: 'mono', cwd: nx },
    ]);
    host.start('shop');
    host.start('mono');
    await tick();
    const envOf = (i: number) => calls[i].options.env as Record<string, string>;
    assert.deepEqual(
      Object.keys(envOf(0)).filter((k) => k.startsWith('NX_') && !(k in process.env)),
      [],
    );
    assert.equal(envOf(1).NX_PARALLEL, '2');
    assert.equal(envOf(1).NX_DAEMON, 'false');
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(nx, { recursive: true, force: true });
  }
});

test('a project kickoff names its PM domain file first when it has one', async () => {
  const { factory, calls } = fakeQuery();
  const host = new SessionHost({ query: factory, attention: new AttentionQueue() });
  host.setLanes([{ ...shop, domain: '.claude/orbit/pm/shop.md' } as LaneConfig, { ...shop, id: 'plain' }]);
  host.start('shop');
  host.start('plain');
  await tick();
  const sent = (i: number) => (calls[i].sent[0] as { message: { content: string } }).message.content;
  assert.equal(
    sent(0),
    'Your PM domain file is .claude/orbit/pm/shop.md; read it before anything else.\n\nRun the Shop board.',
  );
  assert.equal(sent(1), 'Run the Shop board.');
});
