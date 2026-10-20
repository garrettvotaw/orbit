import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuardView, Lane } from '../../../../shared/types.ts';
import { barFraction, formatFree, guardFact, orbMark, panelRows } from './guard.ts';

const GB = 1024 ** 3;
const guard = (over: Partial<GuardView> = {}): GuardView => ({
  headroomBytes: 16.6 * GB,
  totalBytes: 32 * GB,
  state: 'normal',
  slots: [],
  waiting: [],
  ...over,
});
const lanes = [
  { id: 'story-shop-100204', name: '100204 · Delivery', story: { storyId: '100204' } },
  { id: 'cart', name: 'Cart' },
] as unknown as Lane[];

test('formatFree says how much is free and whether Orbit is holding', () => {
  assert.equal(formatFree(16.6 * GB, 'normal'), '16.6 GB free');
  assert.equal(formatFree(6.4 * GB, 'holding'), '6.4 GB free · holding');
  assert.equal(formatFree(2.4 * GB, 'critical'), '2.4 GB free');
});

test('panelRows lists slots then waiters, moons by story number', () => {
  const g = guard({
    slots: [
      {
        laneId: 'story-shop-100204',
        agentId: null,
        label: 'nx affected',
        startedAt: 0,
        background: false,
      },
      { laneId: 'cart', agentId: 'a1', label: 'nx test', startedAt: 140_000, background: false },
    ],
    waiting: [
      {
        laneId: 'story-shop-100241',
        agentId: null,
        label: 'jest',
        since: 0,
        reason: 'slot',
        kind: 'command',
      },
      {
        laneId: 'cart',
        agentId: null,
        label: 'moon start',
        since: 0,
        reason: 'memory',
        kind: 'launch',
      },
    ],
  });
  assert.deepEqual(panelRows(g, lanes, 180_000), [
    { kind: 'slot', who: '100204', what: 'nx affected · 3m' },
    { kind: 'slot', who: 'Cart', what: 'nx test · 40s' },
    { kind: 'wait', who: 'story-shop-100241', what: 'in line' },
    { kind: 'wait', who: 'Cart', what: 'held for memory' },
  ]);
});

test('orbMark marks a lane testing before waiting, and nothing otherwise', () => {
  const g = guard({
    slots: [{ laneId: 'cart', agentId: null, label: 'nx test', startedAt: 0, background: false }],
    waiting: [
      {
        laneId: 'cart',
        agentId: 'a1',
        label: 'jest',
        since: 0,
        reason: 'slot',
        kind: 'command',
      },
      { laneId: 'shop', agentId: null, label: 'jest', since: 0, reason: 'slot', kind: 'command' },
    ],
  });
  assert.equal(orbMark('cart', g), 'testing');
  assert.equal(orbMark('shop', g), 'waiting');
  assert.equal(orbMark('prs', g), null);
});

test('barFraction is the share of memory still free', () => {
  assert.equal(barFraction(guard({ headroomBytes: 8 * GB, totalBytes: 32 * GB })), 0.25);
  assert.equal(barFraction(guard({ totalBytes: 0 })), 0);
  assert.equal(barFraction(guard({ headroomBytes: 40 * GB, totalBytes: 32 * GB })), 1);
});

test('moonFact says testing, in line, or held for a moon in the line', () => {
  const g = guard({
    slots: [{ laneId: 'a', agentId: null, label: 'nx test', startedAt: 0, background: false }],
    waiting: [
      { laneId: 'b', agentId: null, label: 'jest', since: 0, reason: 'slot', kind: 'command' },
      {
        laneId: 'c',
        agentId: null,
        label: 'moon start',
        since: 0,
        reason: 'memory',
        kind: 'launch',
      },
    ],
  });
  assert.deepEqual(
    ['a', 'b', 'c', 'd'].map((id) => guardFact(id, g)),
    ['testing', 'in line', 'held', null],
  );
});
