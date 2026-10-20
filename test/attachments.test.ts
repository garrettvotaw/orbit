import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userContent, withScreenshots } from '../src/main/attachments.ts';

const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const jpeg = { mediaType: 'image/jpeg', data: '/9j/4AAQ' };

test('words alone go as plain text, the way they always have', () => {
  assert.equal(userContent('skip 100107', []), 'skip 100107');
});

test('screenshots go first as base64 image blocks, then the words', () => {
  assert.deepEqual(userContent('this toast never clears', [png, jpeg]), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
    { type: 'text', text: 'this toast never clears' },
  ]);
});

test('a screenshot with no words is just the image', () => {
  assert.deepEqual(userContent('', [png]), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ]);
});

test('the feed notes how many screenshots went with the words', () => {
  assert.equal(withScreenshots('look at the grid', 0), 'look at the grid');
  assert.equal(withScreenshots('look at the grid', 1), 'look at the grid\n[screenshot]');
  assert.equal(withScreenshots('', 2), '[2 screenshots]');
});
