import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePrState, prUrl, PrBoardReader } from '../src/main/pr-board.ts';

const sample = JSON.stringify({
  updatedAt: '2026-10-06T18:33:34.598Z',
  repo: 'contoso/storefront',
  lanes: [
    {
      pr: 7117,
      title: 'Bundle-only visit seeds bundle',
      story: 'AB#100188',
      bucket: 'fixing',
      status: 'fixer mid-edit',
      note: 'blocked on A/B/C',
      stages: {
        ci: { state: 'bad', label: '1 failing' },
        review: { state: 'pending', label: '' },
        merge: { state: 'weird', label: '' },
      },
    },
    { pr: 7101, title: 'Size chart', bucket: 'merged', status: 'merged by Pat' },
    { title: 'no number' },
  ],
  activity: [{ at: '2026-10-06T18:33:34.598Z', text: 'Tick 1155: no change.' }, { text: '' }],
});

test('parsePrState maps lanes, stages, urls, and activity', () => {
  const b = parsePrState(sample, 'prs', 7);
  assert.equal(b.repo, 'contoso/storefront');
  assert.equal(b.fetchedAt, Date.parse('2026-10-06T18:33:34.598Z'));
  assert.equal(b.lanes.length, 2);
  const l = b.lanes[0];
  assert.equal(l.number, 7117);
  assert.equal(l.bucket, 'fixing');
  assert.equal(l.url, 'https://github.com/contoso/storefront/pull/7117');
  assert.equal(l.stages.ci.state, 'bad');
  assert.equal(l.stages.merge.state, 'pending', 'unknown stage states fall back to pending');
  assert.deepEqual(b.activity, [{ at: Date.parse('2026-10-06T18:33:34.598Z'), text: 'Tick 1155: no change.' }]);
});

test('parsePrState survives bad json', () => {
  const b = parsePrState('{nope', 'prs', 9);
  assert.deepEqual(b.lanes, []);
  assert.equal(b.fetchedAt, 9);
  assert.equal(prUrl(null, 5), '#5');
});

test('PrBoardReader reads the file now and again when it changes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-pr-'));
  const file = path.join(dir, 'state.json');
  writeFileSync(file, sample);
  const seen: number[] = [];
  const reader = new PrBoardReader((boards) => seen.push(boards[0]?.lanes.length ?? -1));
  reader.setMonitors([{ id: 'prs', name: 'PRs', skill: 'monitor-prs', cwd: dir, everyMinutes: 20, stateFile: file }]);
  assert.equal(reader.boards()[0].lanes.length, 2);
  writeFileSync(file, JSON.stringify({ lanes: [{ pr: 1, bucket: 'green' }] }));
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(reader.boards()[0].lanes.length, 1);
  reader.stop();
});

test('PrBoardReader reports an empty board when the file is missing', () => {
  const reader = new PrBoardReader(() => {});
  reader.setMonitors([
    { id: 'prs', name: 'PRs', skill: 'monitor-prs', cwd: 'c', everyMinutes: 20, stateFile: 'C:/nope/none.json' },
  ]);
  assert.deepEqual(reader.boards()[0].lanes, []);
  reader.stop();
});
