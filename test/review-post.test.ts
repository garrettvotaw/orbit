import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReview } from '../src/shared/review.ts';
import { postFromLane, prTarget, type ReviewHost } from '../src/main/review-post.ts';
import type { Finding, ReviewPrompt, ReviewResult } from '../src/shared/types.ts';
import { reviewLaneId } from '../src/shared/review.ts';

const finding = (n: number, body?: string): Finding => ({
  n,
  severity: 'minor',
  file: `libs/a/f${n}.ts`,
  line: 10 * n,
  gist: `Gist ${n}.`,
  ...(body === undefined ? {} : { body }),
});
const prompt: ReviewPrompt = {
  findings: [finding(1, 'This query drops every delivery but the first.'), finding(2, 'Needs takeUntilDestroyed.')],
};

test('prTarget reads the repo and number from a pull request address', () => {
  assert.deepEqual(prTarget('https://github.com/contoso/storefront/pull/7127'), {
    repo: 'contoso/storefront',
    number: 7127,
  });
  assert.equal(prTarget('https://example.com/nope'), null);
});

test('planReview posts the kept comments with the picked status, in the shape GitHub takes', () => {
  assert.deepEqual(planReview(prompt, [], 'approve'), {
    kind: 'post',
    payload: {
      event: 'APPROVE',
      comments: [
        { path: 'libs/a/f1.ts', line: 10, body: 'This query drops every delivery but the first.' },
        { path: 'libs/a/f2.ts', line: 20, body: 'Needs takeUntilDestroyed.' },
      ],
    },
  });
  assert.deepEqual(planReview(prompt, [1], 'request'), {
    kind: 'post',
    payload: {
      event: 'REQUEST_CHANGES',
      comments: [{ path: 'libs/a/f2.ts', line: 20, body: 'Needs takeUntilDestroyed.' }],
    },
  });
  assert.deepEqual(planReview(prompt, [1, 2], 'approve'), { kind: 'post', payload: { event: 'APPROVE' } });
  assert.deepEqual(planReview({ findings: [] }, [], 'approve'), { kind: 'post', payload: { event: 'APPROVE' } });
});

test('planReview leaves a PR alone for comment only with nothing kept, and hands Claude what Orbit cannot post', () => {
  assert.deepEqual(planReview(prompt, [1, 2], 'leave'), { kind: 'skip' });
  assert.deepEqual(planReview({ findings: [] }, [], 'leave'), { kind: 'skip' });
  const request = planReview(prompt, [1, 2], 'request');
  assert.equal(request.kind, 'cannot');
  assert.match((request as { reason: string }).reason, /at least one comment/);
  // A preview from before Orbit posted reviews carries no comment text.
  const old = planReview({ findings: [finding(1), finding(2, 'Has text.')] }, [], 'approve');
  assert.equal(old.kind, 'cannot');
  assert.match((old as { reason: string }).reason, /Comment 1 has no text/);
  assert.equal(planReview({ findings: [finding(1), finding(2, 'Has text.')] }, [1], 'approve').kind, 'post');
});

/** A review lane and the gh calls posting makes. */
function fakes(opts: { fail?: string } = {}) {
  const posted: Array<[string, ReviewResult]> = [];
  const stopped: string[] = [];
  const calls: Array<{ args: string[]; input?: string }> = [];
  const lane = {
    pr: { number: 7127, url: 'https://github.com/contoso/storefront/pull/7127' },
    reviewPrompt: prompt as ReviewPrompt | null,
  };
  const host: ReviewHost = {
    lane: (id) => (id === 'review-7127' ? lane : undefined),
    reviewPosted: (id, result) => posted.push([id, result]),
    stop: async (id) => {
      stopped.push(id);
    },
  };
  const gh = async (args: string[], _cwd?: string, input?: string) => {
    calls.push({ args, input });
    if (opts.fail) throw new Error(opts.fail);
    return JSON.stringify({ id: 1, html_url: 'https://github.com/o/r/pull/7127#pullrequestreview-1' });
  };
  return { host, gh, lane, posted, stopped, calls };
}

test('postFromLane posts the review in one call, records it on the lane, and stops the finished session', async () => {
  const { host, gh, posted, stopped, calls } = fakes();
  const result = await postFromLane(host, gh, 'review-7127', [2], 'approve', () => 42);
  assert.deepEqual(
    calls.map((c) => c.args),
    [['api', 'repos/contoso/storefront/pulls/7127/reviews', '--method', 'POST', '--input', '-']],
  );
  assert.deepEqual(JSON.parse(calls[0].input!), {
    event: 'APPROVE',
    comments: [{ path: 'libs/a/f1.ts', line: 10, body: 'This query drops every delivery but the first.' }],
  });
  const ok: ReviewResult = {
    ok: true,
    at: 42,
    event: 'APPROVE',
    comments: 1,
    url: 'https://github.com/o/r/pull/7127#pullrequestreview-1',
  };
  assert.deepEqual(result, ok);
  assert.deepEqual(posted, [['review-7127', ok]]);
  assert.deepEqual(stopped, ['review-7127']);
});

test('postFromLane keeps the preview and the session when GitHub refuses, so Claude can take it from there', async () => {
  const { host, gh, posted, stopped } = fakes({
    fail: 'gh: Unprocessable Entity (HTTP 422): Line could not be resolved',
  });
  const result = await postFromLane(host, gh, 'review-7127', [], 'request', () => 7);
  assert.deepEqual(result, {
    ok: false,
    at: 7,
    pick: 'request',
    error: 'gh: Unprocessable Entity (HTTP 422): Line could not be resolved',
  });
  assert.deepEqual(posted, [['review-7127', result]]);
  assert.deepEqual(stopped, []);
});

test('postFromLane posts nothing for comment only with every comment dropped, and refuses what it cannot post', async () => {
  const { host, gh, lane, posted, calls, stopped } = fakes();
  const skip = await postFromLane(host, gh, 'review-7127', [1, 2], 'leave', () => 1);
  assert.deepEqual(skip, { ok: true, at: 1, event: 'COMMENT', comments: 0, url: null });
  assert.equal(calls.length, 0, 'nothing reaches GitHub');
  assert.deepEqual(stopped, ['review-7127']);

  const cannot = await postFromLane(host, gh, 'review-7127', [1, 2], 'request', () => 2);
  assert.equal(cannot.ok, false);
  assert.match((cannot as { error: string }).error, /at least one comment/);

  lane.reviewPrompt = null;
  const gone = await postFromLane(host, gh, 'review-7127', [], 'approve', () => 3);
  assert.match((gone as { error: string }).error, /no review waiting/);
  assert.equal((await postFromLane(host, gh, 'review-1', [], 'approve', () => 4)).ok, false);
  assert.equal(calls.length, 0);
  assert.equal(posted.length, 4);
});

test('reviewLaneId names the repo and the number', () => {
  assert.equal(reviewLaneId('contoso/storefront', 12), 'review-contoso-storefront-12');
});
