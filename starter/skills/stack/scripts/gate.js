// The merge predicate. This is the one piece of this system that must never be relaxed.
//
// Why it exists: a repo whose ruleset does not dismiss stale reviews on push lets an approval SURVIVE a push. After
// a slice is re-materialized, GitHub still reports reviewDecision APPROVED for code no human has read, and it will
// let that merge. Tracking the SHA a human actually approved is the only thing that catches it. The gate enforces
// freshness whether or not the ruleset does, so it is safe on any repo.
//
// A bot's automatic review is a comment, not the human gate. Neither is a self-approval.

export function isBot(login, typename) {
  if (typename === 'Bot') return true;
  const l = String(login || '').toLowerCase();
  return l.includes('[bot]') || l.includes('copilot');
}

/** The last human, non-self APPROVED review wins. */
export function pickApproval(reviews, prAuthorLogin) {
  let found = null;
  for (const r of reviews || []) {
    if (r.state !== 'APPROVED') continue;
    const a = r.author || {};
    if (isBot(a.login, a.__typename)) continue;
    if (prAuthorLogin && a.login === prAuthorLogin) continue;
    found = { sha: (r.commit || {}).oid || null, login: a.login };
  }
  return found;
}

export function evaluateGate(slice) {
  const reasons = [];
  if (slice.state && slice.state !== 'OPEN') reasons.push('not-open');

  if (slice.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes-requested');
  else if (slice.reviewDecision !== 'APPROVED') reasons.push('awaiting-approval');

  // Freshness. Enforced here because the ruleset may not.
  if (slice.reviewDecision === 'APPROVED' && (!slice.approvedSha || slice.approvedSha !== slice.headSha)) {
    reasons.push('stale-approved');
  }

  if ((slice.unresolvedThreads || 0) > 0) reasons.push('unresolved-threads');

  if (slice.checksStatus === 'FAILURE' || slice.checksStatus === 'ERROR') reasons.push('checks-failing');
  else if (slice.checksStatus !== 'SUCCESS') reasons.push('checks-pending');

  if (slice.mergeable === 'CONFLICTING') reasons.push('conflicting');
  else if (slice.mergeable !== 'MERGEABLE') reasons.push('mergeability-unknown');

  return { mergeable: reasons.length === 0, reasons };
}

export const REASON_HELP = {
  'not-open': 'PR is merged or closed; nothing to do.',
  'awaiting-approval': 'No human approval yet. This is the gate, so wait.',
  'changes-requested': 'A reviewer requested changes. Fix in the integration worktree, then /stack fix.',
  'stale-approved':
    'The approved commit is not the head commit. Someone approved older code. Re-approval is required. This is by design, not a bug.',
  'unresolved-threads': 'Open review threads. Resolve them before merge.',
  'checks-failing': 'Required checks are red. The PR shepherd handles mechanical failures.',
  'checks-pending': 'Checks are still running.',
  conflicting: 'Branch conflicts with its base. Usually a spine file; the PR shepherd can resolve trivial ones.',
  'mergeability-unknown': 'GitHub has not computed mergeability yet. Re-run /stack status shortly.',
};

export const explain = (reasons) => (reasons || []).map((r) => `${r}: ${REASON_HELP[r] || 'unknown reason code'}`);
