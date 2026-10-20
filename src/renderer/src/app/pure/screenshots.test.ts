import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64Bytes, fitSize, MAX_EDGE, MAX_SCREENSHOTS, roomFor } from './screenshots.ts';

test('a big screenshot shrinks to fit the longest edge, keeping its shape', () => {
  assert.deepEqual(fitSize(3840, 2160, MAX_EDGE), { width: 2000, height: 1125 });
  assert.deepEqual(fitSize(1080, 2400, MAX_EDGE), { width: 900, height: 2000 });
});

test('a screenshot that already fits stays its own size', () => {
  assert.deepEqual(fitSize(1280, 720, MAX_EDGE), { width: 1280, height: 720 });
});

test('base64Bytes counts the bytes the data decodes to', () => {
  assert.equal(base64Bytes('QUJD'), 3);
  assert.equal(base64Bytes('QUI='), 2);
  assert.equal(base64Bytes('QQ=='), 1);
});

test('roomFor lets in only as many as fit under the cap', () => {
  assert.equal(MAX_SCREENSHOTS, 5);
  assert.equal(roomFor(0, 3), 3);
  assert.equal(roomFor(4, 3), 1);
  assert.equal(roomFor(5, 1), 0);
});
