import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryGuard, criticalMessage, topByName } from '../src/main/guard.ts';
import { DEFAULT_THRESHOLDS } from '../src/main/memory.ts';
import { TestSlots } from '../src/main/slots.ts';
import { formatElapsed, formatGb } from '../src/shared/guard-format.ts';

const GB = 1024 ** 3;
const flush = () => new Promise((r) => setImmediate(r));

/** A guard whose memory reading the test sets, in GB. */
function rig(testSlots = 2) {
  let gb = 16;
  const alerts: string[] = [];
  let released = 0;
  const slots = new TestSlots({ base: testSlots });
  const guard = new MemoryGuard({
    sample: () => ({ total: (32 * GB) / 1024, free: (gb * GB) / 1024, swapFree: (40 * GB) / 1024 }),
    slots,
    testSlots,
    thresholds: DEFAULT_THRESHOLDS,
    releaseHeld: () => released++,
    alert: (m) => alerts.push(m),
    topProcesses: async () => [{ name: 'jest', bytes: 5.8 * GB }],
    now: () => 0,
  });
  return {
    guard,
    slots,
    alerts,
    released: () => released,
    at(next: number) {
      gb = next;
      guard.tick();
    },
  };
}
const req = (id: string) => ({ laneId: 'shop', agentId: null, toolUseId: id, label: 'nx test', background: false });

test('holding cuts the line to one slot', async () => {
  const r = rig();
  r.at(7);
  assert.equal(r.guard.view().state, 'holding');
  void r.slots.acquire(req('a'));
  void r.slots.acquire(req('b'));
  assert.equal(r.slots.view().slots.length, 1);
  r.at(10);
  assert.equal(r.slots.view().slots.length, 2, 'back to two once memory recovers');
});

test('critical cuts to zero and alerts once per episode', async () => {
  const r = rig();
  r.at(2.4);
  r.at(2.2);
  await flush();
  assert.equal(r.guard.view().state, 'critical');
  void r.slots.acquire(req('a'));
  assert.equal(r.slots.view().slots.length, 0);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0], /^Memory is almost out \(2\.4 GB free\)\./);
});

test('alert re-arms after headroom climbs back to 8 GB', async () => {
  const r = rig();
  r.at(2);
  r.at(5);
  r.at(2);
  await flush();
  assert.equal(r.alerts.length, 1, 'still the same episode below 8 GB');
  r.at(8.5);
  r.at(2);
  await flush();
  assert.equal(r.alerts.length, 2);
});

test('releaseHeld runs only when normal', () => {
  const r = rig();
  r.at(16);
  assert.equal(r.released(), 1);
  r.at(7);
  r.at(9);
  assert.equal(r.released(), 1);
  assert.equal(r.guard.admits(), false);
  r.at(11);
  assert.equal(r.released(), 2);
  assert.equal(r.guard.admits(), true);
});

test('onChange ignores moves under 0.1 GB', () => {
  const r = rig();
  let n = 0;
  r.guard.onChange(() => n++);
  r.at(16);
  r.at(16.05);
  assert.equal(n, 1);
  r.at(16.2);
  assert.equal(n, 2);
  r.at(7.95);
  assert.equal(n, 3, 'a state change always counts');
});

test('criticalMessage names the tests running, the biggest processes, and that nothing was stopped', () => {
  const msg = criticalMessage(
    2.4 * GB,
    [{ laneId: 'story-shop-100204', agentId: null, label: 'nx affected', startedAt: 0, background: false }],
    [
      { name: 'jest', bytes: 5.8 * GB },
      { name: 'chrome', bytes: 3.1 * GB },
    ],
    3 * 60_000,
    (id) => (id === 'story-shop-100204' ? '100204' : id),
  );
  assert.equal(
    msg,
    'Memory is almost out (2.4 GB free). Tests running: 100204 nx affected (3m). Biggest right now: jest 5.8 GB, chrome 3.1 GB. Nothing was stopped.',
  );
  assert.equal(
    criticalMessage(2.4 * GB, [], [], 0, (id) => id),
    'Memory is almost out (2.4 GB free). Nothing was stopped.',
  );
});

test('topByName groups and sorts', () => {
  assert.deepEqual(
    topByName(
      [
        { Name: 'node.exe', WorkingSetSize: 100 },
        { Name: 'chrome.exe', WorkingSetSize: 250 },
        { Name: 'Node.exe', WorkingSetSize: 200 },
        { Name: 'Idle', WorkingSetSize: 8 },
      ],
      2,
    ),
    [
      { name: 'node', bytes: 300 },
      { name: 'chrome', bytes: 250 },
    ],
  );
});

test('formatGb and formatElapsed read the way the panel says them', () => {
  assert.equal(formatGb(16.6 * GB), '16.6 GB');
  assert.equal(formatElapsed(40_000), '40s');
  assert.equal(formatElapsed(3 * 60_000 + 10_000), '3m');
  assert.equal(formatElapsed(65 * 60_000), '1h 5m');
});

test('view reports total memory for the panel bar', () => {
  const r = rig();
  r.at(16);
  assert.equal(r.guard.view().totalBytes, 32 * GB);
});
