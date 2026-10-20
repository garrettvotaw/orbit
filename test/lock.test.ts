import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigLock } from '../src/main/lock.ts';

test('acquire takes the lock, a live holder blocks a second Orbit, a dead one is replaced', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-lock-'));
  const a = new ConfigLock(dir);
  assert.equal(
    a.acquire(100, 'C:/dev/electron.exe', () => true),
    null,
  );
  assert.equal(existsSync(path.join(dir, 'orbit.lock')), true);

  const b = new ConfigLock(dir);
  const other = b.acquire(200, 'C:/Programs/Orbit/Orbit.exe', (pid) => pid === 100);
  assert.deepEqual([other?.pid, other?.exe], [100, 'C:/dev/electron.exe']);

  assert.equal(
    b.acquire(200, 'C:/Programs/Orbit/Orbit.exe', () => false),
    null,
    'a dead holder is replaced',
  );
  b.release();
  assert.equal(existsSync(path.join(dir, 'orbit.lock')), false);
  a.release();
});

test('a corrupt lock file does not block', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-lock-'));
  writeFileSync(path.join(dir, 'orbit.lock'), '{nope');
  assert.equal(
    new ConfigLock(dir).acquire(1, 'x', () => true),
    null,
  );
});

test('re-acquiring with the same pid is fine', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-lock-'));
  const l = new ConfigLock(dir);
  assert.equal(
    l.acquire(7, 'x', () => true),
    null,
  );
  assert.equal(
    l.acquire(7, 'x', () => true),
    null,
  );
});
