import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendsOnKey } from './composer.ts';

const key = (
  k: string,
  mods: { shiftKey?: boolean; ctrlKey?: boolean; isComposing?: boolean } = {},
) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  isComposing: false,
  ...mods,
});

test('Enter and Ctrl+Enter send', () => {
  assert.equal(sendsOnKey(key('Enter')), true);
  assert.equal(sendsOnKey(key('Enter', { ctrlKey: true })), true);
});

test('Shift+Enter is a new line, and Enter mid-composition picks the IME candidate', () => {
  assert.equal(sendsOnKey(key('Enter', { shiftKey: true })), false);
  assert.equal(sendsOnKey(key('Enter', { isComposing: true })), false);
});

test('other keys never send', () => {
  assert.equal(sendsOnKey(key('a')), false);
  assert.equal(sendsOnKey(key('Tab', { ctrlKey: true })), false);
});
