import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/main/db.ts';
import { loadState, createStateSaver, saveState, toPersisted } from '../src/main/state-store.ts';
import type { HostSnapshot } from '../src/shared/types.ts';

const snap: HostSnapshot = {
  lanes: [
    {
      id: 'shop',
      kind: 'project',
      name: 'W',
      sessionId: 's',
      status: 'working',
      model: 'm',
      costUsd: 1.5,
      startedAt: 7,
      lastSummary: null,
      lastReport: null,
      nextTickAt: null,
      agents: [],
      error: null,
    },
  ],
  attention: [],
  spentTodayUsd: 0,
} as unknown as HostSnapshot;
const extras = () => ({
  rates: { m: { perWeighted: 4e-6, perToken: 1e-6, basis: 'list' as const } },
  spent: { day: '2026-10-07', usd: 3.25 },
});

test('a new database loads as empty state', () => {
  const s = loadState(openDb(':memory:'));
  assert.deepEqual(s.lanes, []);
  assert.equal(s.savedAt, 0);
  assert.deepEqual(s.rates, {});
  assert.equal(s.spent, undefined);
});

test('toPersisted keeps the resume fields plus learned prices and the day spend', () => {
  const p = toPersisted(snap, extras());
  assert.deepEqual(p.lanes, [{ id: 'shop', sessionId: 's', status: 'working', startedAt: 7, costUsd: 1.5 }]);
  assert.deepEqual(p.spent, { day: '2026-10-07', usd: 3.25 });
  assert.equal(p.rates?.m.perWeighted, 4e-6);
});

test('saveState and loadState round-trip lanes, prices, and spend, and a later save replaces the lanes', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'orbit-state-')), 'orbit.db');
  saveState(openDb(file), toPersisted(snap, extras()));
  const loaded = loadState(openDb(file));
  assert.deepEqual(loaded.lanes, [{ id: 'shop', sessionId: 's', status: 'working', startedAt: 7, costUsd: 1.5 }]);
  assert.deepEqual(loaded.spent, { day: '2026-10-07', usd: 3.25 });
  assert.equal(loaded.rates?.m.perToken, 1e-6);
  saveState(openDb(file), { lanes: [], savedAt: 1 });
  assert.deepEqual(loadState(openDb(file)).lanes, []);
  assert.deepEqual(loadState(openDb(file)).rates, {});
});

test('saver debounces, then writes the latest snapshot', async () => {
  const db = openDb(':memory:');
  const save = createStateSaver(db, extras, 20);
  save(snap);
  save({ ...snap, lanes: [{ ...snap.lanes[0], costUsd: 2 }] });
  assert.deepEqual(loadState(db).lanes, []);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(loadState(db).lanes[0].costUsd, 2);
});
