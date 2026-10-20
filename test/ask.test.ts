import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestSay } from '../src/shared/ask.ts';
import type { FeedEntry } from '../src/shared/types.ts';

test('latestSay joins the closing text of a finished turn', () => {
  const text = (t: string): FeedEntry => ({ kind: 'text', text: t, tool: null });
  const user = (t: string): FeedEntry => ({ kind: 'user', text: t, tool: null });
  const tool: FeedEntry = { kind: 'tool', text: 'Bash npx nx test', tool: 'Bash' };
  assert.equal(
    latestSay([user('go'), text('Running tests.'), tool, text('Done.'), text('Ship it?')]),
    'Done.\n\nShip it?',
  );
  assert.equal(latestSay([text('Ship it?'), tool]), null, 'a turn still mid-tool has no closing words');
  assert.equal(latestSay([text('Ship it?'), user('yes')]), null);
  assert.equal(latestSay([]), null);
});
