#!/usr/bin/env node
// One sweep: every open non-draft PR you authored in a repo, plus any PR the state file still tracks, fetched in
// one GraphQL call and summarized one block per PR.
//
//   node sum.js --state <stateFile>                          # the usual sweep
//   node sum.js --state <stateFile> 12 15                    # only these PRs
//   node sum.js --repo owner/name 12                         # a PR in another repo
//   node sum.js --state <stateFile> --required "build,unit"  # required checks from the runbook
//
// The repo is --repo, else the state file's repo, else what gh sees in the current folder. Required checks are
// --required, else the base branch's rules from the GitHub API; when neither names any, every check counts.
// It always fetches before it prints, so it can't summarize an old snapshot. With --state, the raw response is
// also saved as graph.json beside the state file.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const take = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value;
};
const stateFile = take('--state');
const requiredArg = take('--required');
let repo = take('--repo');
const asked = argv.filter((a) => /^\d+$/.test(a)).map(Number);

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

const state = stateFile ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
repo ??= state?.repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
const [owner, name] = repo.split('/');

/** Open non-draft PRs by you, plus lanes the state file tracks in this repo that it hasn't marked merged. */
function prsToSweep() {
  if (asked.length) return asked;
  const open = JSON.parse(
    gh(['pr', 'list', '-R', repo, '--author', '@me', '--state', 'open', '--json', 'number,isDraft', '--limit', '50']),
  );
  const tracked = (state?.lanes ?? [])
    .filter((l) => typeof l.pr === 'number' && !['merged', 'closed'].includes(l.bucket))
    .filter((l) => (l.repo ?? state.repo) === repo)
    .map((l) => l.pr);
  const mine = open.filter((p) => !p.isDraft).map((p) => p.number);
  return [...new Set([...mine, ...tracked])].sort((a, b) => a - b);
}

/** GraphQL comments run to the end of the line, so drop them before folding the query onto one line. */
function buildQuery(numbers) {
  const fragment = readFileSync(path.join(import.meta.dirname, 'q.graphql'), 'utf8')
    .replace(/#.*$/gm, '')
    .replace(/\s+/g, ' ');
  const aliases = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ...PR }`).join(' ');
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } } ${fragment}`;
}

function fetchGraph(numbers) {
  const args = ['api', 'graphql', '-f', `query=${buildQuery(numbers)}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
  try {
    return gh(args);
  } catch (e) {
    // gh exits non-zero when any alias failed (a PR number that doesn't exist) but still prints the rest.
    if (e.stdout && e.stdout.trim().startsWith('{')) return e.stdout;
    throw e;
  }
}

/** Required check names for a base branch: rulesets first, then classic protection. Empty when neither has any. */
const requiredCache = new Map();
function requiredFor(base) {
  if (requiredArg !== undefined) {
    return {
      names: requiredArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      from: '--required',
    };
  }
  if (requiredCache.has(base)) return requiredCache.get(base);
  const names = new Set();
  const from = [];
  try {
    const rules = JSON.parse(gh(['api', `repos/${repo}/rules/branches/${encodeURIComponent(base)}`]));
    for (const r of rules) {
      if (r.type !== 'required_status_checks') continue;
      for (const c of r.parameters?.required_status_checks ?? []) names.add(c.context);
    }
    if (names.size) from.push('ruleset');
  } catch {
    // no rules readable for this branch
  }
  try {
    const classic = JSON.parse(
      gh(['api', `repos/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`]),
    );
    const before = names.size;
    for (const c of classic.contexts ?? []) names.add(c);
    for (const c of classic.checks ?? []) names.add(c.context);
    if (names.size > before) from.push('branch protection');
  } catch {
    // not protected, or no permission to read it
  }
  const result = { names: [...names], from: from.join(' + ') || 'none found' };
  requiredCache.set(base, result);
  return result;
}

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const RED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const login = (who) => who?.login ?? 'ghost';

/** The latest decisive review per author: a later CHANGES_REQUESTED or DISMISSED replaces an earlier APPROVED. */
function latestReviews(reviews) {
  const latest = new Map();
  const decisive = reviews
    .filter((r) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  for (const r of decisive) latest.set(login(r.author), r);
  return [...latest.entries()];
}

function summarize(p) {
  if (p.state !== 'OPEN') return [`#${p.number} ${p.state}${p.mergedAt ? ` ${p.mergedAt}` : ''}  ${p.title}`];
  if (p.isDraft) return [`#${p.number} DRAFT (back to draft, not monitored)  ${p.title}`];
  const c = p.commits.nodes[0]?.commit;
  // When the head was committed, not pushed: a commit made before an approval and pushed after it still reads as
  // covered here, so a push you know came later wins over this mark.
  const headAt = c ? Date.parse(c.committedDate) : 0;
  const reviews = latestReviews(p.reviews.nodes);
  const approving = reviews
    .filter(([, r]) => r.state === 'APPROVED')
    .map(([a, r]) => `${a}@${r.submittedAt}${Date.parse(r.submittedAt) > headAt ? '' : ' OLDER-THAN-HEAD'}`);
  const blocking = reviews.filter(([, r]) => r.state === 'CHANGES_REQUESTED').map(([a]) => a);
  const dismissed = reviews.filter(([, r]) => r.state === 'DISMISSED').map(([a, r]) => `${a}@${r.submittedAt}`);
  // GitHub returns a null reviewer for a team your token can't read, so that one still counts as requested.
  const requested = p.reviewRequests.nodes.map((n) => {
    const who = n.requestedReviewer;
    return who?.login ?? (who?.slug ? `team ${who.slug}` : 'a team you cannot see');
  });

  // A StatusContext has no name, only a context, so fall back to it or those rows drop out.
  const byName = {};
  const urlOf = {};
  for (const n of c?.statusCheckRollup?.contexts.nodes ?? []) {
    const key = n.name ?? n.context;
    byName[key] = n.conclusion ?? n.status ?? n.state;
    urlOf[key] = n.detailsUrl ?? n.targetUrl ?? '';
  }
  /** A red check with the Actions run behind it, so the log and the rerun are one step away. */
  const withRun = (k) => {
    const run = /\/actions\/runs\/(\d+)/.exec(urlOf[k] ?? '');
    return run ? `${k} (run ${run[1]})` : k;
  };
  const req = requiredFor(p.baseRefName);
  const checks = req.names.length ? req.names : Object.keys(byName);
  const green = checks.filter((k) => GREEN.has(byName[k]));
  const red = checks.filter((k) => RED.has(byName[k])).map(withRun);
  const absent = checks.filter((k) => !(k in byName));
  const otherRed = Object.keys(byName)
    .filter((k) => RED.has(byName[k]) && !checks.includes(k))
    .map(withRun);
  const running = Object.entries(byName).filter(([, v]) => !GREEN.has(v) && !RED.has(v)).length;

  const threads = p.reviewThreads.nodes;
  const open = threads.filter((t) => !t.isResolved);
  const resolvedBy = threads.filter((t) => t.resolvedBy).map((t) => login(t.resolvedBy));
  const author = login(p.author);

  const lines = [
    `#${p.number} ${p.mergeStateStatus} mergeable=${p.mergeable} base=${p.baseRefName} head=${p.headRefName}@${c?.oid.slice(0, 10) ?? '?'} committed ${c?.committedDate ?? '?'}`,
    `   ${p.title}`,
    `   reviews: approving=[${approving.join(', ')}] blocking=[${blocking.join(', ')}] dismissed=[${dismissed.join(', ')}] requested=[${requested.join(', ')}]`,
    req.names.length
      ? `   required (${req.from}): ${green.length}/${checks.length} green; RED=[${red.join(', ')}] ABSENT=[${absent.join(', ')}]`
      : `   required: none found (pass --required from the runbook); all checks ${green.length}/${checks.length} green; RED=[${red.join(', ')}]`,
    `   other failing: [${otherRed.join(', ')}] running: ${running}`,
    `   threads: ${threads.length} total, ${open.length} unresolved (${open.filter((t) => t.isOutdated).length} outdated); resolvedBy: [${resolvedBy.join(', ')}]`,
  ];
  for (const t of open) {
    const [first, ...rest] = t.comments.nodes;
    const answered = rest.some((m) => login(m.author) === author) ? 'answered' : 'UNANSWERED';
    const gist = (first?.body ?? '').replace(/\s+/g, ' ').slice(0, 60);
    lines.push(
      `     ${t.id} ${t.path}${t.line ? ` line ${t.line}` : ''} by ${login(first?.author)} ${answered}: ${gist}`,
    );
  }
  return lines;
}

const numbers = prsToSweep();
console.log(`${repo}: ${numbers.length} PRs, fetched ${new Date().toISOString()}`);
if (!numbers.length) process.exit(0);

const raw = fetchGraph(numbers);
if (stateFile) writeFileSync(path.join(path.dirname(stateFile), 'graph.json'), raw);
const graph = JSON.parse(raw);
for (const e of graph.errors ?? []) console.log(`ERROR: ${e.message}`);
const prs = graph.data?.repository ?? {};
for (const n of numbers) {
  const p = prs[`p${n}`];
  console.log(p ? summarize(p).join('\n') : `#${n} not found`);
}
