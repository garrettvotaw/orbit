import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestSlots, type SlotRequest } from '../src/main/slots.ts';

const req = (toolUseId: string, laneId = 'shop', background = false): SlotRequest => ({
  laneId,
  agentId: null,
  toolUseId,
  label: 'nx test',
  background,
});
const tick = () => new Promise((r) => setImmediate(r));
/** Track whether a pending acquire has settled, and to what. */
function watch(p: Promise<boolean>) {
  const w = { settled: false, value: null as boolean | null };
  void p.then((v) => {
    w.settled = true;
    w.value = v;
  });
  return w;
}

test('grants up to base then queues FIFO', async () => {
  const s = new TestSlots({ base: 2 });
  const a = watch(s.acquire(req('a')));
  const b = watch(s.acquire(req('b')));
  const c = watch(s.acquire(req('c')));
  await tick();
  assert.deepEqual([a.value, b.value, c.settled], [true, true, false]);
  assert.deepEqual(
    s.view().waiting.map((w) => w.label),
    ['nx test'],
  );
});

test('finish hands the slot to the next waiter', async () => {
  const s = new TestSlots({ base: 1 });
  await s.acquire(req('a'));
  const b = watch(s.acquire(req('b')));
  const c = watch(s.acquire(req('c')));
  s.finish('a');
  await tick();
  assert.deepEqual([b.value, c.settled], [true, false]);
  assert.deepEqual(
    s.view().slots.map((x) => x.laneId),
    ['shop'],
  );
});

test('finish ignores background slots', async () => {
  const s = new TestSlots({ base: 1 });
  await s.acquire(req('a', 'shop', true));
  const b = watch(s.acquire(req('b')));
  s.finish('a');
  await tick();
  assert.equal(b.settled, false);
  assert.equal(s.view().slots[0].background, true);
});

test('a slot backgrounded after it started also outlives finish', async () => {
  const s = new TestSlots({ base: 1 });
  await s.acquire(req('a'));
  s.background('a', 't1');
  const b = watch(s.acquire(req('b')));
  s.finish('a');
  await tick();
  assert.equal(b.settled, false);
});

test('taskEnded frees a background slot', async () => {
  const s = new TestSlots({ base: 1 });
  await s.acquire(req('a', 'shop', true));
  const b = watch(s.acquire(req('b')));
  s.taskEnded('a');
  await tick();
  assert.equal(b.value, true);
});

test('liveTasks frees a background slot whose task vanished', async () => {
  const s = new TestSlots({ base: 1 });
  await s.acquire(req('a', 'shop', true));
  s.task('a', 't1');
  const b = watch(s.acquire(req('b', 'prs')));
  s.liveTasks('shop', ['t1']);
  await tick();
  assert.equal(b.settled, false);
  s.liveTasks('prs', []);
  await tick();
  assert.equal(b.settled, false, 'another lane’s level signal leaves it alone');
  s.liveTasks('shop', ['t9']);
  await tick();
  assert.equal(b.value, true);
});

test('abort removes a waiter and resolves false', async () => {
  const s = new TestSlots({ base: 1 });
  await s.acquire(req('a'));
  const ctl = new AbortController();
  const b = watch(s.acquire(req('b'), ctl.signal));
  ctl.abort();
  await tick();
  assert.equal(b.value, false);
  assert.equal(s.view().waiting.length, 0);
  s.finish('a');
  assert.equal(s.view().slots.length, 0);
});

test('dropLane frees held and resolves waiters false', async () => {
  const s = new TestSlots({ base: 1 });
  await s.acquire(req('a', 'shop'));
  const b = watch(s.acquire(req('b', 'shop')));
  const c = watch(s.acquire(req('c', 'prs')));
  assert.equal(s.holds('shop'), true);
  s.dropLane('shop');
  await tick();
  assert.deepEqual([b.value, c.value], [false, true]);
  assert.equal(s.holds('shop'), false);
});

test('cut(1) with two held grants nobody until both finish, then one', async () => {
  const s = new TestSlots({ base: 2 });
  await s.acquire(req('a'));
  await s.acquire(req('b'));
  s.cut(1);
  const c = watch(s.acquire(req('c')));
  const d = watch(s.acquire(req('d')));
  s.finish('a');
  await tick();
  assert.equal(c.settled, false);
  s.finish('b');
  await tick();
  assert.deepEqual([c.value, d.settled], [true, false]);
});

test('cut(0) grants nobody; cut(null) grants two', async () => {
  const s = new TestSlots({ base: 2 });
  s.cut(0);
  const a = watch(s.acquire(req('a')));
  const b = watch(s.acquire(req('b')));
  await tick();
  assert.deepEqual([a.settled, b.settled], [false, false]);
  s.cut(null);
  await tick();
  assert.deepEqual([a.value, b.value], [true, true]);
});

test('waiter reason is memory under a cut, slot otherwise', async () => {
  const s = new TestSlots({ base: 2 });
  await s.acquire(req('a'));
  await s.acquire(req('b'));
  void s.acquire(req('c'));
  assert.equal(s.view().waiting[0].reason, 'slot');
  s.cut(1);
  s.finish('a');
  void s.acquire(req('d'));
  assert.deepEqual(
    s.view().waiting.map((w) => w.reason),
    ['memory', 'memory'],
  );
});

test('has says whether a command got its slot', async () => {
  const s = new TestSlots({ base: 1 });
  void s.acquire(req('a'));
  void s.acquire(req('b'));
  assert.deepEqual([s.has('a'), s.has('b')], [true, false]);
});

test('sweep frees foreground after 15 min and background after 45', async () => {
  let now = 0;
  const s = new TestSlots({ base: 2, now: () => now });
  await s.acquire(req('fg'));
  await s.acquire(req('bg', 'shop', true));
  now = 15 * 60_000 + 1;
  assert.deepEqual(
    s.sweep().map((x) => x.background),
    [false],
  );
  now = 45 * 60_000 + 1;
  assert.deepEqual(
    s.sweep().map((x) => x.background),
    [true],
  );
  assert.equal(s.view().slots.length, 0);
});

test('onChange fires when the line moves', async () => {
  const s = new TestSlots({ base: 1 });
  let n = 0;
  s.onChange(() => n++);
  await s.acquire(req('a'));
  void s.acquire(req('b'));
  s.finish('a');
  assert.ok(n >= 3, `fired ${n} times`);
});
