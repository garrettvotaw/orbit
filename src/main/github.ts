import { execFile } from 'node:child_process';
import type { CheckSummary, ReviewDecision, TeamPr, TeamPrBoard } from '../shared/types.ts';

/**
 * The Reviews list's query: every open PR with only the one state GitHub rolls its head commit's
 * checks up to. `gh pr list --json statusCheckRollup` fetches every check run on every PR instead,
 * and across a repo's open PRs GitHub times that out (a 504, or JSON cut off part way). One line,
 * so it passes through Windows argument quoting untouched.
 */
export const TEAM_PRS_QUERY = [
  'query($owner: String!, $name: String!) {',
  'repository(owner: $owner, name: $name) {',
  'pullRequests(states: OPEN, first: 80, orderBy: {field: UPDATED_AT, direction: DESC}) {',
  'nodes { number title url isDraft updatedAt headRefName additions deletions reviewDecision',
  'author { login }',
  'reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }',
  'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }',
  '} } } }',
].join(' ');

interface RawPr {
  number: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  updatedAt?: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  author?: { login?: string } | null;
  reviewRequests?: {
    nodes?: Array<{ requestedReviewer?: { __typename?: string; login?: string; slug?: string } | null }>;
  };
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> };
}

/** The one state GitHub rolls a head commit's checks up to, as the Reviews list shows it. */
export function rollupChecks(state: string | null | undefined): CheckSummary {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

/** Every check run on a commit, as `gh pr list --json statusCheckRollup` returns them. */
export type CheckRuns = Array<{ status?: string; conclusion?: string; state?: string }>;

export function summarizeChecks(rollup: CheckRuns | undefined): CheckSummary {
  if (!rollup?.length) return 'none';
  let pending = false;
  let success = false;
  for (const c of rollup) {
    const conclusion = (c.conclusion || c.state || '').toUpperCase();
    const status = (c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion))
      return 'failure';
    if (status && status !== 'COMPLETED') pending = true;
    else if (!conclusion && status !== 'COMPLETED') pending = true;
    if (conclusion === 'SUCCESS') success = true;
  }
  return pending ? 'pending' : success ? 'success' : 'none';
}

function decisionOf(raw: string | null | undefined): ReviewDecision {
  switch (raw) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'REVIEW_REQUIRED':
      return 'review-required';
    default:
      return 'none';
  }
}

/**
 * Keep teammates' open, non-draft PRs from the Reviews query's response; yours belong to the PR
 * monitor, drafts are not ready for eyes.
 */
export function parsePrList(json: string, me: string, repo: string): TeamPr[] {
  let raw: RawPr[];
  try {
    const res = JSON.parse(json) as { data?: { repository?: { pullRequests?: { nodes?: RawPr[] } } } | null };
    raw = res.data?.repository?.pullRequests?.nodes ?? [];
  } catch {
    return [];
  }
  const mine = me.toLowerCase();
  return raw
    .filter((p) => typeof p.number === 'number' && !p.isDraft && (p.author?.login ?? '').toLowerCase() !== mine)
    .map((p) => {
      const requests = (p.reviewRequests?.nodes ?? []).map((n) => n.requestedReviewer ?? {});
      const requested: TeamPr['requested'] = requests.some((r) => (r.login ?? '').toLowerCase() === mine)
        ? 'you'
        : requests.some((r) => r.__typename === 'Team' || r.slug)
          ? 'team'
          : null;
      return {
        repo,
        number: p.number,
        title: p.title ?? '',
        author: p.author?.login ?? '',
        url: p.url ?? '',
        branch: p.headRefName ?? '',
        updatedAt: Date.parse(p.updatedAt ?? '') || 0,
        decision: decisionOf(p.reviewDecision),
        checks: rollupChecks(p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
        requested,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
      };
    })
    .sort(byNeed);
}

const byNeed = (a: TeamPr, b: TeamPr) => rank(a) - rank(b) || b.updatedAt - a.updatedAt;

/** What deserves your eyes first: asked of you, then asked of your team, then everything still waiting. */
function rank(p: TeamPr): number {
  if (p.requested === 'you') return 0;
  if (p.requested === 'team' && p.decision !== 'approved') return 1;
  if (p.decision === 'review-required') return 2;
  if (p.decision === 'changes-requested') return 3;
  return 4;
}

/** Run gh with these arguments; `input`, when given, is written to its stdin (for `--input -`). */
export type GhRunner = (args: string[], cwd?: string, input?: string) => Promise<string>;

export function ghRunner(): GhRunner {
  return (args, cwd, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'gh',
        args,
        { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err)
            reject(
              new Error(
                `gh: ${
                  String(stderr || err.message)
                    .trim()
                    .split('\n')[0]
                }`,
              ),
            );
          else resolve(stdout);
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    });
}

/** The constellations' query: one page of a PR search, with when each one merged. One line, as above. */
export const MERGED_PRS_QUERY = [
  'query($q: String!, $after: String) {',
  'search(query: $q, type: ISSUE, first: 100, after: $after) {',
  'pageInfo { hasNextPage endCursor }',
  'nodes { ... on PullRequest { number title url mergedAt headRefName body } }',
  '} }',
].join(' ');

/** Stop paging somewhere sane; GitHub's search ends at 1,000 results anyway. */
const MERGED_MAX_PAGES = 10;

export interface MergedPr {
  number: number;
  title: string;
  url: string;
  mergedAt: number;
  /** Where a Jira key usually sits when the title doesn't carry it. */
  branch: string;
  body: string;
}

interface MergedResponse {
  data?: {
    search?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: Array<{
        number?: number;
        title?: string;
        url?: string;
        mergedAt?: string | null;
        headRefName?: string;
        body?: string;
      }>;
    };
  };
}

export function parseMergedPage(json: string): { prs: MergedPr[]; next: string | null } {
  const search = (JSON.parse(json) as MergedResponse).data?.search;
  const prs = (search?.nodes ?? []).flatMap((n) =>
    typeof n.number === 'number' && n.mergedAt
      ? [
          {
            number: n.number,
            title: n.title ?? '',
            url: n.url ?? '',
            mergedAt: Date.parse(n.mergedAt),
            branch: n.headRefName ?? '',
            body: n.body ?? '',
          },
        ]
      : [],
  );
  const page = search?.pageInfo;
  return { prs, next: page?.hasNextPage && page.endCursor ? page.endCursor : null };
}

/** Every PR merged into the repo since `since` (a `YYYY-MM-DD` day). */
export async function fetchMerged(gh: GhRunner, repo: string, since: string): Promise<MergedPr[]> {
  const out: MergedPr[] = [];
  let after: string | null = null;
  for (let page = 0; page < MERGED_MAX_PAGES; page++) {
    const args = ['api', 'graphql', '-f', `q=repo:${repo} is:pr is:merged merged:>=${since}`];
    if (after) args.push('-f', `after=${after}`);
    const { prs, next } = parseMergedPage(await gh([...args, '-f', `query=${MERGED_PRS_QUERY}`]));
    out.push(...prs);
    if (!next) break;
    after = next;
  }
  return out;
}

/** The team's open PRs across every lane's repo, ranked by what needs your eyes. */
export class GitHubPrs {
  #board: TeamPrBoard = { repos: [], fetchedAt: 0, prs: [], error: null };
  #me: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inflight: Promise<void> | null = null;
  readonly #gh: GhRunner;
  readonly #now: () => number;
  readonly #onBoard: (b: TeamPrBoard) => void;
  #repos: () => Promise<string[]> = async () => [];

  constructor(onBoard: (b: TeamPrBoard) => void, gh: GhRunner = ghRunner(), now: () => number = Date.now) {
    this.#onBoard = onBoard;
    this.#gh = gh;
    this.#now = now;
  }

  board(): TeamPrBoard {
    return this.#board;
  }

  /** Point at the repos to gather from and start polling. */
  configure(opts: { repos: () => Promise<string[]>; pollMinutes?: number }): void {
    this.#repos = opts.repos;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.refresh(), Math.max(1, opts.pollMinutes ?? 5) * 60_000);
    (this.#timer as { unref?: () => void }).unref?.();
    void this.refresh();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  refresh(): Promise<void> {
    this.#inflight ??= this.#refresh().finally(() => (this.#inflight = null));
    return this.#inflight;
  }

  async #refresh(): Promise<void> {
    try {
      const repos = await this.#repos();
      this.#me ??= (await this.#gh(['api', 'user', '-q', '.login'])).trim();
      const results = await Promise.all(repos.map((repo) => this.#fetch(repo)));
      const errors = results.flatMap((r) => (r.error ? [r.error] : []));
      const prs = results.flatMap((r) => r.prs).sort(byNeed);
      this.#board = { repos, fetchedAt: this.#now(), prs, error: errors.length ? errors.join('; ') : null };
    } catch (e) {
      this.#board = { ...this.#board, error: (e as Error).message };
    }
    this.#onBoard(this.#board);
  }

  /** One repo's PRs; on failure, the last good ones it had, and the error naming it. */
  async #fetch(repo: string): Promise<{ prs: TeamPr[]; error: string | null }> {
    const [owner, name] = repo.split('/');
    try {
      const json = await this.#gh([
        'api',
        'graphql',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-f',
        `query=${TEAM_PRS_QUERY}`,
      ]);
      return { prs: parsePrList(json, this.#me ?? '', repo), error: null };
    } catch (e) {
      return { prs: this.#board.prs.filter((p) => p.repo === repo), error: `${repo}: ${(e as Error).message}` };
    }
  }
}
