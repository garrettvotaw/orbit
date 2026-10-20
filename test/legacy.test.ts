import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/main/db.ts';
import { decisionRows, DecisionStore } from '../src/main/decisions.ts';
import { importLegacy } from '../src/main/legacy.ts';
import { laneRows, loadState } from '../src/main/state-store.ts';
import { mailRows, storyRows, StoryStore, type StoryRecord } from '../src/main/stories.ts';
import type { Decision, PersistedLane } from '../src/shared/types.ts';

/** Every field set and none null, so a field a table forgets shows up as a difference. */
const decision: Decision = {
  id: 'd1',
  n: 3,
  laneId: 'shop',
  laneName: 'Shop',
  question: 'Which store should the paperwork show?',
  today: 'The delivery store.',
  proposed: 'The ordering store.',
  options: ['Delivery', 'Ordering'],
  story: '100203',
  askedAt: 10,
  status: 'answered',
  answer: 'Delivery',
  answeredAt: 20,
  deliveredAt: 30,
  sentAt: 15,
};
const story: StoryRecord = {
  id: 'story-shop-100233',
  parentId: 'shop',
  parentName: 'Shop',
  storyId: '100233',
  title: 'Coupon pick before save',
  brief: 'Build it.',
  cwd: 'C:/src/ea',
  agent: 'story-manager',
  model: 'opus',
  stage: 'pr-opened',
  pr: 7162,
  prUrl: 'https://github.com/o/r/pull/7162',
  files: ['a.ts', 'b.ts'],
  waitingOn: ['100234'],
  waitingFiles: ['c.ts'],
  summary: 'PR is up.',
  worktree: 'C:/src/wt',
  branch: 'story/100233',
  startedAt: 1,
  updatedAt: 2,
  reports: [{ at: 2, stage: 'pr-opened', summary: 'PR is up.' }],
};
const lane: PersistedLane = { id: 'shop', sessionId: 's1', status: 'idle', startedAt: 5, costUsd: 1.25 };
const mail = { laneId: 'shop', text: 'Story report 100233 (pr-opened)', at: 3 };

test('every field of a question, a story, mail, and a lane survives its table', () => {
  const db = openDb(':memory:');
  decisionRows(db).put([decision]);
  storyRows(db).put([story]);
  mailRows(db).add([mail]);
  laneRows(db).put([lane]);
  assert.deepEqual(decisionRows(db).all(), [decision]);
  assert.deepEqual(storyRows(db).all(), [story]);
  assert.deepEqual(mailRows(db).all(), [mail]);
  assert.deepEqual(laneRows(db).all(), [lane]);
});

function legacyDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-legacy-'));
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      lanes: [lane],
      savedAt: 9,
      rates: { m: { perWeighted: 1, perToken: 2, basis: 'list' } },
      spent: { day: '2026-10-13', usd: 4.5 },
    }),
  );
  writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ decisions: [decision] }));
  writeFileSync(path.join(dir, 'stories.json'), JSON.stringify({ stories: [story], mail: [mail] }));
  return dir;
}

test('the old files move into the database once and are renamed .imported', () => {
  const dir = legacyDir();
  const db = openDb(path.join(dir, 'orbit.db'));
  assert.deepEqual(importLegacy(db, dir), ['state.json', 'decisions.json', 'stories.json']);
  for (const f of ['state.json', 'decisions.json', 'stories.json']) {
    assert.equal(existsSync(path.join(dir, f)), false, `${f} is gone`);
    assert.equal(existsSync(path.join(dir, `${f}.imported`)), true, `${f}.imported is kept`);
  }
  const state = loadState(db);
  assert.deepEqual(state.lanes, [lane]);
  assert.equal(state.savedAt, 9);
  assert.deepEqual(state.spent, { day: '2026-10-13', usd: 4.5 });
  assert.equal(state.rates?.m.perToken, 2);
  assert.deepEqual(new DecisionStore(db).get('d1'), decision);
  const stories = new StoryStore(db);
  assert.deepEqual(stories.get(story.id), story);
  assert.deepEqual(stories.pending('shop'), [mail]);
  assert.deepEqual(importLegacy(db, dir), [], 'a second run finds nothing to move');
});

test('a file whose table already has rows is left alone', () => {
  const dir = legacyDir();
  const db = openDb(':memory:');
  decisionRows(db).put([{ ...decision, id: 'other', n: 1 }]);
  assert.deepEqual(importLegacy(db, dir), ['state.json', 'stories.json']);
  assert.equal(existsSync(path.join(dir, 'decisions.json')), true);
  assert.deepEqual(
    decisionRows(db)
      .all()
      .map((d) => d.id),
    ['other'],
  );
});

test('a file that will not parse is left alone and logged, and its table starts empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-legacy-'));
  writeFileSync(path.join(dir, 'decisions.json'), '{not json');
  writeFileSync(path.join(dir, 'stories.json'), '');
  const logged: string[] = [];
  const db = openDb(':memory:');
  assert.deepEqual(
    importLegacy(db, dir, (m) => logged.push(m)),
    ['stories.json'],
    'an empty file imports as nothing',
  );
  assert.equal(existsSync(path.join(dir, 'decisions.json')), true);
  assert.match(logged[0], /decisions\.json/);
  assert.equal(decisionRows(db).count(), 0);
});

test('a question missing fields an older Orbit never wrote imports with them null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-legacy-'));
  const { sentAt: _sent, ...old } = decision;
  writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ decisions: [old] }));
  const db = openDb(':memory:');
  importLegacy(db, dir);
  assert.equal(new DecisionStore(db).get('d1')?.sentAt, null);
});
