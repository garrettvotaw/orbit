import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMorning, runMorning } from '../src/main/morning.ts';

test('planMorning skips live lanes and keeps order', () => {
  assert.deepEqual(
    planMorning(['shop', 'cart', 'prs'], (id) => id === 'cart'),
    ['shop', 'prs'],
  );
});

test('runMorning starts the first now and staggers the rest', () => {
  const started: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const fakeTimeout = ((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  runMorning(['shop', 'cart', 'prs'], (id) => started.push(id), 10_000, fakeTimeout);
  assert.deepEqual(started, ['shop']);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [10_000, 20_000],
  );
  timers.forEach((t) => t.fn());
  assert.deepEqual(started, ['shop', 'cart', 'prs']);
});
