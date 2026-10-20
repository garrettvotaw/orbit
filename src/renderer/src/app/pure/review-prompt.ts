import { planReview } from '../../../../shared/review.ts';
import type {
  ReviewEvent,
  ReviewPick,
  ReviewPrompt,
  ReviewResult,
} from '../../../../shared/types.ts';

export type { Finding, ReviewPrompt, ReviewResult, Severity } from '../../../../shared/types.ts';
export type Decision = ReviewPick;

const DECISION_TEXT: Record<Decision, string> = {
  approve: 'Approve.',
  request: 'Request changes.',
  leave: 'Leave as-is (comment only).',
};

/** One message that answers both of the skill's questions: which comments to post, and the review status. */
export function reviewReply(
  prompt: ReviewPrompt,
  dropped: Set<number>,
  decision: Decision,
): string {
  const parts: string[] = [];
  if (prompt.findings.length) {
    const drop = prompt.findings.map((f) => f.n).filter((n) => dropped.has(n));
    if (!drop.length) parts.push('Post all comments.');
    else if (drop.length === prompt.findings.length) parts.push('Post no comments.');
    else
      parts.push(
        `Drop comment${drop.length === 1 ? '' : 's'} ${drop.join(', ')} and post the rest.`,
      );
  }
  parts.push(DECISION_TEXT[decision]);
  return parts.join(' ');
}

const VERB: Record<ReviewEvent, string> = {
  APPROVE: 'approves',
  REQUEST_CHANGES: 'requests changes',
  COMMENT: 'comments',
};

const plural = (n: number) => `${n} comment${n === 1 ? '' : 's'}`;

/** What a status button does with the comments kept: Orbit posts it, leaves the PR alone, or Claude gets it. */
export function pickTitle(prompt: ReviewPrompt, dropped: Set<number>, decision: Decision): string {
  const plan = planReview(prompt, dropped, decision);
  if (plan.kind === 'skip') return 'Posts nothing; the PR stays as it is';
  if (plan.kind === 'cannot')
    return `Sends to Claude: ${reviewReply(prompt, dropped, decision)} (${plan.reason})`;
  const { event, comments = [] } = plan.payload;
  if (!comments.length)
    return `${VERB[event][0].toUpperCase()}${VERB[event].slice(1)} with no comments`;
  return `Posts ${plural(comments.length)} and ${VERB[event]}`;
}

const DONE: Record<ReviewEvent, string> = {
  APPROVE: 'approved',
  REQUEST_CHANGES: 'changes requested',
  COMMENT: 'commented',
};

/** The line a review lane shows once Orbit posted its review. */
export function postedText(result: Extract<ReviewResult, { ok: true }>): string {
  if (result.event === 'COMMENT' && !result.comments && !result.url)
    return 'Left as is · nothing posted';
  return ['Posted', DONE[result.event], ...(result.comments ? [plural(result.comments)] : [])].join(
    ' · ',
  );
}
