import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushableStream } from '../src/main/input-stream.ts';

test('yields pushed items in order and completes on end', async () => {
  const s = new PushableStream<number>();
  s.push(1);
  s.push(2);
  const out: number[] = [];
  const done = (async () => {
    for await (const x of s) out.push(x);
  })();
  await Promise.resolve();
  s.push(3);
  s.end();
  await done;
  assert.deepEqual(out, [1, 2, 3]);
});

test('a consumer waiting on an empty stream wakes on push', async () => {
  const s = new PushableStream<string>();
  const it = s[Symbol.asyncIterator]();
  const next = it.next();
  s.push('a');
  assert.deepEqual(await next, { value: 'a', done: false });
});

test('push after end is ignored', async () => {
  const s = new PushableStream<number>();
  s.end();
  s.push(9);
  const it = s[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
  assert.equal(s.ended, true);
});
