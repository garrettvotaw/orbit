import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTitle, postedText, reviewReply, type ReviewPrompt } from './review-prompt.ts';

const preview: ReviewPrompt = {
  findings: [
    {
      n: 1,
      severity: 'major',
      file: 'cart.controller.ts',
      line: 48,
      gist: 'The flag check runs after the ERP call.',
    },
    {
      n: 2,
      severity: 'minor',
      file: 'return.component.ts',
      line: 112,
      gist: 'This subscribe() has no takeUntilDestroyed.',
    },
  ],
};

test('reviewReply answers both questions in one message', () => {
  assert.equal(reviewReply(preview, new Set(), 'approve'), 'Post all comments. Approve.');
  assert.equal(
    reviewReply(preview, new Set([2]), 'request'),
    'Drop comment 2 and post the rest. Request changes.',
  );
  assert.equal(
    reviewReply(preview, new Set([1, 2]), 'leave'),
    'Post no comments. Leave as-is (comment only).',
  );
  assert.equal(
    reviewReply(preview, new Set([2, 9]), 'approve'),
    'Drop comment 2 and post the rest. Approve.',
  );
  assert.equal(
    reviewReply({ findings: [] }, new Set(), 'request'),
    'Request changes.',
    'a clean PR asks only for a status',
  );
});

test('postedText says what reached GitHub', () => {
  const at = 1;
  assert.equal(
    postedText({ ok: true, at, event: 'APPROVE', comments: 3, url: 'u' }),
    'Posted · approved · 3 comments',
  );
  assert.equal(
    postedText({ ok: true, at, event: 'REQUEST_CHANGES', comments: 1, url: 'u' }),
    'Posted · changes requested · 1 comment',
  );
  assert.equal(
    postedText({ ok: true, at, event: 'APPROVE', comments: 0, url: 'u' }),
    'Posted · approved',
  );
  assert.equal(
    postedText({ ok: true, at, event: 'COMMENT', comments: 0, url: null }),
    'Left as is · nothing posted',
  );
});

test('pickTitle says what a status button will do: post it, leave the PR alone, or hand it to Claude', () => {
  const withText: ReviewPrompt = {
    findings: preview.findings.map((f) => ({ ...f, body: `${f.gist} More detail.` })),
  };
  assert.equal(pickTitle(withText, new Set(), 'approve'), 'Posts 2 comments and approves');
  assert.equal(
    pickTitle(withText, new Set([1]), 'request'),
    'Posts 1 comment and requests changes',
  );
  assert.equal(pickTitle(withText, new Set([1, 2]), 'approve'), 'Approves with no comments');
  assert.equal(
    pickTitle(withText, new Set([1, 2]), 'leave'),
    'Posts nothing; the PR stays as it is',
  );
  assert.equal(
    pickTitle(withText, new Set([1, 2]), 'request'),
    'Sends to Claude: Post no comments. Request changes. (Requesting changes needs at least one comment to say what.)',
  );
  assert.equal(
    pickTitle(preview, new Set(), 'approve'),
    'Sends to Claude: Post all comments. Approve. (Comment 1 has no text for Orbit to post.)',
  );
});
