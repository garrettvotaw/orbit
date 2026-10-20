import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, shouldTick, TICK_TEXT, tickText } from '../src/main/scheduler.ts';
import { emptyLane, type Lane, type MonitorConfig } from '../src/shared/types.ts';

const prs: MonitorConfig = { id: 'prs', name: 'PRs', skill: 'monitor-prs', cwd: 'c', everyMinutes: 20, stateFile: 'x' };
const laneWith = (status: Lane['status']): Lane => ({ ...emptyLane({ kind: 'monitor', ...prs }), status });

test('shouldTick only when live and idle', () => {
  assert.equal(shouldTick(laneWith('idle'), true), true);
  assert.equal(shouldTick(laneWith('working'), true), false);
  assert.equal(shouldTick(laneWith('idle'), false), false);
  assert.equal(shouldTick(undefined, true), false);
});

function harness(status: Lane['status'], live = true) {
  const h = { status };
  const sent: string[] = [];
  const nextTicks: Array<number | null> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let now = 1_000;
  const host = {
    isLive: () => live,
    lane: () => laneWith(h.status),
    send: (_id: string, text: string) => {
      sent.push(text);
      return true;
    },
    setNextTick: (_id: string, at: number | null) => nextTicks.push(at),
  };
  const s = new Scheduler({
    host,
    now: () => now,
    setInterval: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearInterval: () => {},
  });
  return {
    s,
    sent,
    nextTicks,
    timers,
    advance: (ms: number) => (now += ms),
    set status(v: Lane['status']) {
      h.status = v;
    },
  };
}

test('ticks an idle monitor on its cadence and publishes the next tick time', () => {
  const h = harness('idle');
  h.s.setMonitors([prs]);
  assert.equal(h.timers[0].ms, 20 * 60_000);
  assert.deepEqual(h.nextTicks, [1_000 + 20 * 60_000]);
  h.advance(20 * 60_000);
  h.timers[0].fn();
  assert.deepEqual(h.sent, [TICK_TEXT]);
  assert.equal(h.nextTicks.at(-1), 1_000 + 40 * 60_000);
});

test('skips a working monitor and does not queue the tick', () => {
  const h = harness('working');
  h.s.setMonitors([prs]);
  h.timers[0].fn();
  h.timers[0].fn();
  assert.deepEqual(h.sent, []);
});

test('setMonitors is idempotent and clears removed monitors', () => {
  const h = harness('idle');
  h.s.setMonitors([prs]);
  h.s.setMonitors([prs]);
  assert.equal(h.timers.length, 1);
  h.s.setMonitors([]);
  assert.equal(h.nextTicks.at(-1), null);
});

test('tickText is a bare tick unless the watcher saw something', () => {
  assert.equal(tickText([]), TICK_TEXT);
  assert.equal(tickText(['- #1 a: CI went red']), 'tick\nGitHub changed since your last sweep:\n- #1 a: CI went red');
});

test('wake sends an idle monitor a tick naming what changed', () => {
  const h = harness('idle');
  h.s.setMonitors([prs]);
  h.s.wake('prs', ['- #7117 Bundle: CI went red']);
  assert.deepEqual(h.sent, ['tick\nGitHub changed since your last sweep:\n- #7117 Bundle: CI went red']);
});

test('wake on a busy monitor waits, piles up, and goes out as one tick on flush', () => {
  const h = harness('working');
  h.s.setMonitors([prs]);
  h.s.wake('prs', ['- #1 a: approved']);
  h.s.wake('prs', ['- #2 b: new commits']);
  h.s.flush();
  assert.deepEqual(h.sent, []);
  h.status = 'idle';
  h.s.flush();
  assert.deepEqual(h.sent, ['tick\nGitHub changed since your last sweep:\n- #1 a: approved\n- #2 b: new commits']);
  h.s.flush();
  assert.equal(h.sent.length, 1, 'delivered once');
});

test('a scheduled tick carries anything still waiting', () => {
  const h = harness('working');
  h.s.setMonitors([prs]);
  h.s.wake('prs', ['- #1 a: approved']);
  h.status = 'idle';
  h.timers[0].fn();
  assert.deepEqual(h.sent, ['tick\nGitHub changed since your last sweep:\n- #1 a: approved']);
  h.timers[0].fn();
  assert.deepEqual(h.sent.at(-1), TICK_TEXT);
});

test('wake ignores monitors that are stopped or unknown', () => {
  const h = harness('idle', false);
  h.s.setMonitors([prs]);
  h.s.wake('prs', ['- #1 a: approved']);
  h.s.wake('nope', ['- #1 a: approved']);
  assert.deepEqual(h.sent, []);
});

test('a wake survives the host reporting the send as a change before the lane leaves idle', () => {
  // The real host appends the message to the feed (a change) before it marks the lane working,
  // and every change calls flush(); this used to recurse until the stack overflowed.
  let status: Lane['status'] = 'idle';
  const sent: string[] = [];
  let s: Scheduler;
  const host = {
    isLive: () => true,
    lane: () => laneWith(status),
    send: (_id: string, text: string) => {
      sent.push(text);
      s.flush();
      status = 'working';
      s.flush();
      return true;
    },
    setNextTick: () => {},
  };
  s = new Scheduler({
    host,
    setInterval: (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval,
    clearInterval: () => {},
  });
  s.setMonitors([prs]);
  s.wake('prs', ['- #1 a: approved']);
  assert.deepEqual(sent, ['tick\nGitHub changed since your last sweep:\n- #1 a: approved']);
  status = 'idle';
  s.flush();
  assert.equal(sent.length, 1, 'nothing left to deliver');
});

test('a failed send keeps the lines for the next try', () => {
  const h = harness('idle');
  let ok = false;
  h.s = new Scheduler({
    host: {
      isLive: () => true,
      lane: () => laneWith('idle'),
      send: (_id: string, text: string) => {
        h.sent.push(text);
        return ok;
      },
      setNextTick: () => {},
    },
    setInterval: (() => 1 as unknown as NodeJS.Timeout) as typeof setInterval,
    clearInterval: () => {},
  });
  h.s.setMonitors([prs]);
  h.s.wake('prs', ['- #1 a: approved']);
  assert.equal(h.sent.length, 1);
  ok = true;
  h.s.flush();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1], 'tick\nGitHub changed since your last sweep:\n- #1 a: approved');
  h.s.flush();
  assert.equal(h.sent.length, 2, 'delivered once it succeeded');
});
