// Rebuilds the whole picture from GitHub in one call.
//
// There is no polling anywhere in this system. GitHub is the event log: it already recorded every approval,
// comment, and check while the laptop was closed. state.json holds the last-seen values, so a single GraphQL query
// diffed against it reconstructs everything that happened overnight.
import { execFileSync } from 'node:child_process';
import * as gate from './gate.js';

const PR_FIELDS = [
  'number',
  'state',
  'mergeable',
  'reviewDecision',
  'isDraft',
  'headRefName',
  'baseRefName',
  'author { login }',
  'commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }',
  'reviewThreads(first: 100) { nodes { isResolved isOutdated } }',
  'reviews(first: 100) { nodes { state commit { oid } author { login __typename } submittedAt } }',
].join(' ');

export function buildQuery(owner, repo, prNumbers) {
  if (!prNumbers || !prNumbers.length) return null;
  const body = prNumbers.map((n) => `    pr${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join('\n');
  return `query {\n  repository(owner: "${owner}", name: "${repo}") {\n${body}\n  }\n}`;
}

export function parseResponse(json) {
  const repo = ((json || {}).data || {}).repository || {};
  const out = {};
  for (const pr of Object.values(repo)) {
    if (!pr || typeof pr.number !== 'number') continue;
    const commit = (((pr.commits || {}).nodes || [])[0] || {}).commit || {};
    const rollup = commit.statusCheckRollup;
    out[pr.number] = {
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      headSha: commit.oid || null,
      headRefName: pr.headRefName || null,
      baseRefName: pr.baseRefName || null,
      reviewDecision: pr.reviewDecision || null,
      // Count unresolved and not-outdated: an outdated thread whose code moved on does not block.
      unresolvedThreads: ((pr.reviewThreads || {}).nodes || []).filter((t) => !t.isResolved && !t.isOutdated).length,
      checksStatus: rollup && rollup.state ? rollup.state : 'PENDING',
      mergeable: pr.mergeable || 'UNKNOWN',
      authorLogin: (pr.author || {}).login || null,
      reviews: (pr.reviews || {}).nodes || [],
    };
  }
  return out;
}

export function fetchFacts(owner, repo, prNumbers) {
  const q = buildQuery(owner, repo, prNumbers);
  if (!q) return {};
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${q}`], {
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
  return parseResponse(JSON.parse(out));
}

const SOFT_REASONS = ['checks-pending', 'awaiting-approval', 'mergeability-unknown'];

/** Status is derived from the gate, never asserted directly. */
function statusFrom(slice, f) {
  if (f.state === 'MERGED') return { status: 'merged', blockedReason: null };
  if (f.state === 'CLOSED') return { status: 'blocked', blockedReason: 'pr-closed' };
  const verdict = gate.evaluateGate(slice);
  if (verdict.mergeable) return { status: 'approved', blockedReason: null };
  // Waiting on a human or on CI is normal open-PR life, not "blocked".
  const soft = verdict.reasons.every((r) => SOFT_REASONS.includes(r));
  return { status: soft ? 'open' : 'blocked', blockedReason: verdict.reasons.join(',') };
}

function deltaFor(id, slice, prev) {
  const base = { slice: id, pr: slice.prNumber };
  if (slice.status !== prev.status) {
    return { ...base, kind: 'status', from: prev.status, to: slice.status, reason: slice.blockedReason };
  }
  if (prev.approvedSha !== slice.approvedSha && slice.approvedSha) {
    return { ...base, kind: 'approval', by: slice.approvedBy };
  }
  if (prev.checksStatus !== slice.checksStatus) {
    return { ...base, kind: 'checks', from: prev.checksStatus, to: slice.checksStatus };
  }
  return null;
}

/** Fold fresh facts into state and report what changed. */
export function applyFacts(state, facts, nowIso) {
  const deltas = [];
  for (const [id, slice] of Object.entries(state.slices || {})) {
    const f = slice.prNumber && facts[slice.prNumber];
    if (!f) continue;
    const prev = { status: slice.status, checksStatus: slice.checksStatus, approvedSha: slice.approvedSha };
    const approval = gate.pickApproval(f.reviews, f.authorLogin);
    Object.assign(slice, {
      state: f.state,
      headSha: f.headSha,
      reviewDecision: f.reviewDecision,
      unresolvedThreads: f.unresolvedThreads,
      checksStatus: f.checksStatus,
      mergeable: f.mergeable,
      approvedSha: approval ? approval.sha : null,
      approvedBy: approval ? approval.login : null,
    });
    Object.assign(slice, statusFrom(slice, f));
    const d = deltaFor(id, slice, prev);
    if (d) deltas.push(d);
  }
  if (nowIso) state.lastReconciledAt = nowIso;
  return { state, deltas };
}

export const prNumbersOf = (state) =>
  Object.values(state.slices || {})
    .map((s) => s.prNumber)
    .filter((n) => typeof n === 'number');

/** Slices whose gate passes right now. */
export function mergeableSlices(state) {
  return Object.entries(state.slices || {})
    .filter(([, s]) => s.prNumber && s.status !== 'merged' && gate.evaluateGate(s).mergeable)
    .map(([id]) => id);
}

export function formatDelta(d) {
  const head = `slice "${d.slice}" (PR #${d.pr})`;
  if (d.kind === 'status') return `${head}: ${d.from} -> ${d.to}${d.reason ? ` [${d.reason}]` : ''}`;
  if (d.kind === 'approval') return `${head}: approved by ${d.by}`;
  return `${head}: checks ${d.from} -> ${d.to}`;
}
