import type { ReviewEvent, ReviewPick, ReviewPrompt } from './types.ts';

/** A review lane's id: one per PR, and two repos can each have a #12. */
export function reviewLaneId(repo: string, number: number): string {
  return `review-${repo.replace('/', '-')}-${number}`;
}

export const REVIEW_EVENT: Record<ReviewPick, ReviewEvent> = {
  approve: 'APPROVE',
  request: 'REQUEST_CHANGES',
  leave: 'COMMENT',
};

/** The body GitHub's create-review call takes: the status and the inline comments, sent as one review. */
export interface ReviewPayload {
  event: ReviewEvent;
  comments?: Array<{ path: string; line: number; body: string }>;
}

/**
 * What Orbit does with your pick: post it, leave the PR alone (comment only with nothing kept), or
 * hand it to Claude because Orbit cannot post it itself.
 */
export type ReviewPlan =
  { kind: 'post'; payload: ReviewPayload } | { kind: 'skip' } | { kind: 'cannot'; reason: string };

/**
 * Turn the preview, the comments you dropped, and the status you picked into one review. A kept
 * comment with no text (a preview from before Orbit posted reviews) or changes requested with no
 * comment to say what goes to Claude instead.
 */
export function planReview(prompt: ReviewPrompt, dropped: Iterable<number>, pick: ReviewPick): ReviewPlan {
  const drop = new Set(dropped);
  const kept = prompt.findings.filter((f) => !drop.has(f.n));
  const bare = kept.find((f) => !f.body?.trim());
  if (bare) return { kind: 'cannot', reason: `Comment ${bare.n} has no text for Orbit to post.` };
  if (!kept.length && pick === 'leave') return { kind: 'skip' };
  if (!kept.length && pick === 'request')
    return { kind: 'cannot', reason: 'Requesting changes needs at least one comment to say what.' };
  const event = REVIEW_EVENT[pick];
  if (!kept.length) return { kind: 'post', payload: { event } };
  return {
    kind: 'post',
    payload: { event, comments: kept.map((f) => ({ path: f.file, line: f.line, body: f.body!.trim() })) },
  };
}
