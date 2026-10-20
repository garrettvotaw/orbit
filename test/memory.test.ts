import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS, headroomBytes, nextMemoryState, slotLimit } from '../src/main/memory.ts';
import type { MemoryState } from '../src/shared/types.ts';

const GB = 1024 ** 3;

test('memory state moves with hysteresis so it does not flap', () => {
  const rows: Array<[MemoryState, number, MemoryState]> = [
    ['normal', 9, 'normal'],
    ['normal', 7.9, 'holding'],
    ['holding', 9.9, 'holding'],
    ['holding', 10, 'normal'],
    ['holding', 2.9, 'critical'],
    ['critical', 3.5, 'critical'],
    ['critical', 4, 'holding'],
    ['normal', 2, 'critical'],
    ['critical', 12, 'normal'],
  ];
  for (const [prev, gb, next] of rows)
    assert.equal(nextMemoryState(prev, gb * GB, DEFAULT_THRESHOLDS), next, `${prev} at ${gb} GB`);
});

test('the slot count steps down with memory', () => {
  assert.equal(slotLimit('normal', 2), 2);
  assert.equal(slotLimit('holding', 2), 1);
  assert.equal(slotLimit('critical', 2), 0);
  assert.equal(slotLimit('normal', 3), 3);
  assert.equal(slotLimit('holding', 0), 0);
});

test('headroom is the lower of available memory and free commit', () => {
  assert.equal(headroomBytes({ free: 16_000_000, swapFree: 36_000_000 }), 16_000_000 * 1024);
  assert.equal(headroomBytes({ free: 16_000_000, swapFree: 2_000_000 }), 2_000_000 * 1024);
  assert.equal(headroomBytes({ free: 16_000_000, swapFree: 0 }), 16_000_000 * 1024);
});
