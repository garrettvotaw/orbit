import { planReview } from '../shared/review.ts';
import type { ReviewPick, ReviewPrompt, ReviewResult } from '../shared/types.ts';
import type { GhRunner } from './github.ts';

/** Owner/name and number from a pull request's web address. */
export function prTarget(url: string): { repo: string; number: number } | null {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** What posting needs from the session host: the review lane, a place for the outcome, and a stop. */
export interface ReviewHost {
  lane(laneId: string): { pr: { number: number; url: string } | null; reviewPrompt: ReviewPrompt | null } | undefined;
  reviewPosted(laneId: string, result: ReviewResult): void;
  stop(laneId: string): Promise<void>;
}

/**
 * Post a review lane's preview to GitHub with the comments you kept and the status you picked, in
 * one call so the author gets one notification, with no model turn in between. A posted review
 * finishes the lane, so its session stops. When GitHub refuses, the preview and the session stay,
 * and the outcome says what you picked so Claude can take it from there.
 */
export async function postFromLane(
  host: ReviewHost,
  gh: GhRunner,
  laneId: string,
  dropped: number[],
  pick: ReviewPick,
  now: () => number = Date.now,
): Promise<ReviewResult> {
  const result = await post(host, gh, laneId, dropped, pick, now);
  host.reviewPosted(laneId, result);
  if (result.ok) await host.stop(laneId);
  return result;
}

async function post(
  host: ReviewHost,
  gh: GhRunner,
  laneId: string,
  dropped: number[],
  pick: ReviewPick,
  now: () => number,
): Promise<ReviewResult> {
  const refuse = (error: string): ReviewResult => ({ ok: false, at: now(), pick, error });
  const lane = host.lane(laneId);
  const target = lane?.pr ? prTarget(lane.pr.url) : null;
  if (!lane || !target) return refuse('This lane is not a review of a GitHub pull request.');
  if (!lane.reviewPrompt) return refuse('There is no review waiting on a status.');
  const plan = planReview(lane.reviewPrompt, dropped, pick);
  if (plan.kind === 'cannot') return refuse(plan.reason);
  if (plan.kind === 'skip') return { ok: true, at: now(), event: 'COMMENT', comments: 0, url: null };
  try {
    const out = await gh(
      ['api', `repos/${target.repo}/pulls/${target.number}/reviews`, '--method', 'POST', '--input', '-'],
      undefined,
      JSON.stringify(plan.payload),
    );
    const url = (JSON.parse(out) as { html_url?: string }).html_url ?? null;
    return { ok: true, at: now(), event: plan.payload.event, comments: plan.payload.comments?.length ?? 0, url };
  } catch (e) {
    return refuse((e as Error).message);
  }
}
