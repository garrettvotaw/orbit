import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addLaneToConfig,
  defaultUserName,
  normalizeConfig,
  expandHome,
  laneIdFor,
  lanesOf,
  loadConfig,
  removeLaneFromConfig,
  saveConfig,
  setLaneModel,
} from '../src/main/config.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'orbit-cfg-'));
const cwd = path.join(dir, 'repo');
mkdirSync(cwd);
const good = {
  projects: [
    { id: 'shop', name: 'Shop', agent: 'shop-pm', cwd, ado: { org: 'o', project: 'p', anchorId: 1 }, kickoff: 'go' },
  ],
  monitors: [{ id: 'prs', name: 'PRs', skill: 'monitor-prs', cwd, everyMinutes: 20, stateFile: '~/x.json' }],
  morning: ['shop', 'prs'],
};
const write = (name: string, obj: unknown) => {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

test('loads and fills defaults', () => {
  const cfg = loadConfig(write('a.json', good));
  assert.equal(cfg.alerts.toast, true);
  assert.equal(cfg.alerts.sound, false);
  assert.equal(cfg.adoPollMinutes, 2);
  assert.equal(cfg.monitors[0].stateFile, expandHome('~/x.json'));
  assert.equal('storyMoons' in cfg, false, 'moons are on unless the config says otherwise');
});

test('keeps the optional top-level settings it knows about, including the story moon ones', () => {
  const cfg = loadConfig(
    write('a2.json', {
      ...good,
      githubRepo: 'o/r',
      theme: 'light',
      storyMoons: false,
      storyWipCap: 3,
      storyModel: 'sonnet',
      storyAgent: 'drill-moon',
      unknown: 'dropped',
    }),
  );
  assert.equal(cfg.githubRepo, 'o/r');
  assert.equal(cfg.theme, 'light');
  assert.equal(cfg.storyMoons, false);
  assert.equal(cfg.storyWipCap, 3);
  assert.equal(cfg.storyModel, 'sonnet');
  assert.equal(cfg.storyAgent, 'drill-moon');
  assert.equal('unknown' in cfg, false);
});

test('keeps the memory guard settings when set, and leaves them out otherwise', () => {
  const cfg = loadConfig(
    write('a3.json', { ...good, testSlots: 3, memoryHoldGb: 6, memoryResumeGb: 9, memoryCriticalGb: 2 }),
  );
  assert.deepEqual([cfg.testSlots, cfg.memoryHoldGb, cfg.memoryResumeGb, cfg.memoryCriticalGb], [3, 6, 9, 2]);
  const plain = loadConfig(write('a4.json', good));
  assert.equal('testSlots' in plain, false);
  assert.equal('memoryHoldGb' in plain, false);
  const zero = loadConfig(write('a5.json', { ...good, testSlots: 0 }));
  assert.equal(zero.testSlots, 0, 'zero slots is a real setting');
});

test('lanesOf tags kind and keeps order projects then monitors', () => {
  const lanes = lanesOf(loadConfig(write('b.json', good)));
  assert.deepEqual(
    lanes.map((l) => [l.id, l.kind]),
    [
      ['shop', 'project'],
      ['prs', 'monitor'],
    ],
  );
});

test('rejects duplicate ids', () => {
  const dup = { ...good, monitors: [{ ...good.monitors[0], id: 'shop' }] };
  assert.throws(() => loadConfig(write('c.json', dup)), /duplicate lane id "shop"/);
});

test('rejects a cwd that does not exist', () => {
  const bad = { ...good, projects: [{ ...good.projects[0], cwd: path.join(dir, 'nope') }] };
  assert.throws(() => loadConfig(write('d.json', bad)), /cwd does not exist/);
});

test('rejects a morning id that is not a lane', () => {
  assert.throws(() => loadConfig(write('e.json', { ...good, morning: ['ghost'] })), /morning lane "ghost"/);
});

test('expandHome replaces a leading ~', () => {
  assert.ok(!expandHome('~/a/b').startsWith('~'));
  assert.equal(expandHome('C:/x'), 'C:/x');
});

test('chats load, sit after monitors, and may name a model', () => {
  const cfg = loadConfig(write('f.json', { ...good, chats: [{ id: 'ask', name: 'Ask', cwd, model: 'sonnet' }] }));
  const lanes = lanesOf(cfg);
  assert.deepEqual(
    lanes.map((l) => l.id),
    ['shop', 'prs', 'ask'],
  );
  assert.equal(lanes[2].kind, 'chat');
  assert.equal(lanes[2].model, 'sonnet');
});

test('laneIdFor slugs the name and avoids taken ids', () => {
  const cfg = loadConfig(write('g.json', good));
  assert.equal(laneIdFor('Quick Chat!', cfg), 'quick-chat');
  assert.equal(laneIdFor('Shop', cfg), 'shop-2');
  assert.equal(laneIdFor('###', cfg), 'lane');
});

test('addLaneToConfig, removeLaneFromConfig, and setLaneModel are pure and round-trip through save', () => {
  const cfg = loadConfig(write('h.json', good));
  const added = addLaneToConfig(cfg, { kind: 'chat', id: 'ask', name: 'Ask', cwd });
  assert.equal(cfg.chats.length, 0, 'original untouched');
  assert.equal(added.chats[0].id, 'ask');
  assert.throws(() => addLaneToConfig(added, { kind: 'chat', id: 'ask', name: 'Dup', cwd }), /duplicate lane id/);

  const withModel = setLaneModel(added, 'ask', 'opus');
  assert.equal(withModel.chats[0].model, 'opus');
  assert.equal(setLaneModel(withModel, 'ask', null).chats[0].model, undefined);
  assert.equal(setLaneModel(withModel, 'shop', 'fable').projects[0].model, 'fable');

  const file = path.join(dir, 'saved.json');
  saveConfig(file, withModel);
  const back = loadConfig(file);
  assert.equal(back.chats[0].model, 'opus');

  const removed = removeLaneFromConfig(back, 'shop');
  assert.equal(removed.projects.length, 0);
  assert.deepEqual(removed.morning, ['prs'], 'removed lane leaves the morning list too');
});

test('defaultUserName takes the first part of the login, capitalised', () => {
  assert.equal(defaultUserName('Pat.Doe'), 'Pat');
  assert.equal(defaultUserName('pat_doe'), 'Pat');
  assert.equal(defaultUserName('sam'), 'Sam');
  assert.equal(defaultUserName(''), 'the user');
});

test('normalizeConfig keeps userName and productTerms when set', () => {
  const cfg = normalizeConfig({ userName: 'Pat', productTerms: ['CORE', 'OEM'] });
  assert.equal(cfg.userName, 'Pat');
  assert.deepEqual(cfg.productTerms, ['CORE', 'OEM']);
  const bare = normalizeConfig({});
  assert.equal(bare.userName, undefined);
  assert.equal(bare.productTerms, undefined);
});
