import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildTracker, unpacked } from '../src/main/children.ts';

const exited = (p: { once(ev: 'exit', cb: () => void): unknown; exitCode: number | null }) =>
  p.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => p.once('exit', () => r()));

test('spawn tracks the child and forgets it when it exits', async () => {
  const t = new ChildTracker();
  const child = t.spawn({ command: process.execPath, args: ['-e', 'process.exit(0)'], env: process.env });
  assert.equal(t.size, 1);
  await exited(child);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.size, 0);
});

test('killAll terminates a child that ignores stdin EOF', async () => {
  const t = new ChildTracker();
  const child = t.spawn({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: process.env });
  assert.equal(child.exitCode, null);
  await t.killAll(50);
  await exited(child);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'child should have been terminated');
  assert.equal(t.size, 0);
});

test('killLane kills only that lane’s children', async () => {
  const t = new ChildTracker();
  const spin = (lane: string) =>
    t.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: { ...process.env, ORBIT_LANE: lane },
    });
  const shop = spin('shop');
  const prs = spin('prs');
  try {
    assert.equal(t.killLane('shop'), true);
    await exited(shop);
    assert.equal(prs.exitCode, null, 'the other lane keeps running');
    assert.equal(t.killLane('nobody'), false);
  } finally {
    await t.killAll(0);
  }
  await exited(prs);
});

test('unpacked points an asar path at the unpacked copy and leaves other paths alone', () => {
  assert.equal(
    unpacked(
      'C:\\Users\\g\\AppData\\Local\\Programs\\Orbit\\resources\\app.asar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe',
    ),
    'C:\\Users\\g\\AppData\\Local\\Programs\\Orbit\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe',
  );
  assert.equal(
    unpacked('/opt/Orbit/resources/app.asar/node_modules/x/claude'),
    '/opt/Orbit/resources/app.asar.unpacked/node_modules/x/claude',
  );
  assert.equal(
    unpacked('C:\\src\\orbit\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'),
    'C:\\src\\orbit\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe',
  );
  assert.equal(unpacked('C:\\app.asar.unpacked\\x.exe'), 'C:\\app.asar.unpacked\\x.exe', 'already unpacked stays put');
});
