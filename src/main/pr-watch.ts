import type { CheckSummary, MonitorConfig, ReviewDecision } from '../shared/types.ts';
import { ghRunner, summarizeChecks, type GhRunner } from './github.ts';

/** The fields `gh pr list --json` returns for the watcher. */
export const WATCH_FIELDS = [
  'number',
  'title',
  'isDraft',
  'updatedAt',
  'headRefOid',
  'mergeStateStatus',
  'reviewDecision',
  'statusCheckRollup',
] as const;

export const DEFAULT_WATCH_SECONDS = 60;

interface RawPr {
  number: number;
  title?: string;
  isDraft?: boolean;
  updatedAt?: string;
  headRefOid?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }>;
}

/** What the watcher remembers about one of your open PRs between polls. */
export interface PrFacts {
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  updatedAt: number;
  head: string;
  checks: CheckSummary;
  conflicting: boolean;
  decision: ReviewDecision;
}

export interface PrChange {
  repo: string;
  number: number;
  title: string;
  what: string;
}

/** Keyed `owner/name#number`: two repos can each have a #12. */
export function parseWatchList(json: string, repo: string): Map<string, PrFacts> {
  let raw: RawPr[];
  try {
    raw = JSON.parse(json) as RawPr[];
  } catch {
    return new Map();
  }
  const out = new Map<string, PrFacts>();
  for (const p of raw) {
    if (typeof p.number !== 'number') continue;
    out.set(`${repo}#${p.number}`, {
      repo,
      number: p.number,
      title: p.title ?? '',
      draft: !!p.isDraft,
      updatedAt: Date.parse(p.updatedAt ?? '') || 0,
      head: p.headRefOid ?? '',
      checks: summarizeChecks(p.statusCheckRollup),
      conflicting: p.mergeStateStatus === 'CONFLICTING' || p.mergeStateStatus === 'DIRTY',
      decision: decisionOf(p.reviewDecision),
    });
  }
  return out;
}

function decisionOf(raw: string | undefined): ReviewDecision {
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
 * What changed between two polls that the PR monitor would act on. Drafts are skipped, as the
 * monitor skips them. CI merely starting is not a change; CI finishing is.
 */
export function diffFacts(prev: Map<string, PrFacts>, next: Map<string, PrFacts>): PrChange[] {
  const changes: PrChange[] = [];
  const of = (f: PrFacts, what: string): PrChange => ({ repo: f.repo, number: f.number, title: f.title, what });
  for (const [key, was] of prev) {
    if (was.draft) continue;
    const now = next.get(key);
    if (!now) changes.push(of(was, 'closed or merged'));
    else if (now.draft) changes.push(of(now, 'back to draft'));
  }
  for (const [key, now] of next) {
    if (now.draft) continue;
    const was = prev.get(key);
    if (!was || was.draft) {
      changes.push(of(now, was ? 'ready for review' : 'opened'));
      continue;
    }
    const what: string[] = [];
    if (now.head !== was.head) what.push('new commits');
    if (now.checks !== was.checks && (now.checks === 'failure' || now.checks === 'success'))
      what.push(now.checks === 'failure' ? 'CI went red' : 'CI went green');
    if (now.conflicting !== was.conflicting) what.push(now.conflicting ? 'now conflicting' : 'conflicts resolved');
    if (now.decision !== was.decision && now.decision !== 'none')
      what.push(now.decision === 'approved' ? 'approved' : now.decision.replace('-', ' '));
    if (!what.length && now.updatedAt > was.updatedAt) what.push('new comment or review');
    if (what.length) changes.push(of(now, what.join(', ')));
  }
  return changes.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
}

/** One line per moved PR, as the monitor's tick lists them; the repo is named only once there are two. */
export function changeLines(changes: PrChange[]): string[] {
  const many = new Set(changes.map((c) => c.repo)).size > 1;
  return changes.map((c) => `- ${many ? c.repo : ''}#${c.number} ${c.title}: ${c.what}`);
}

export interface WatchTarget {
  monitorId: string;
  cwd: string;
  everySeconds: number;
}

/**
 * Watches your open PRs on a short, LLM-free cadence and reports the moments something moves,
 * so the PR monitor can sweep then instead of on a timer. The first poll only sets a baseline.
 */
export class PrWatcher {
  readonly #gh: GhRunner;
  readonly #onChange: (monitorId: string, changes: PrChange[]) => void;
  readonly #onError: (monitorId: string, message: string) => void;
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Per monitor, per repo: a repo's first answer is only its baseline, however late it comes. */
  readonly #facts = new Map<string, Map<string, Map<string, PrFacts>>>();
  #repoList: () => Promise<string[]> = async () => [];
  readonly #repos = new Map<string, string>();
  readonly #targets = new Map<string, WatchTarget>();
  readonly #inflight = new Map<string, Promise<void>>();

  constructor(deps: {
    onChange: (monitorId: string, changes: PrChange[]) => void;
    onError?: (monitorId: string, message: string) => void;
    gh?: GhRunner;
  }) {
    this.#gh = deps.gh ?? ghRunner();
    this.#onChange = deps.onChange;
    this.#onError = deps.onError ?? (() => {});
  }

  /**
   * Monitors whose `watchSeconds` is not 0 get a watcher; everything else is left to the schedule.
   * Each watches every repo `repos` names when it polls; with none, the repo of its own folder.
   */
  setMonitors(monitors: MonitorConfig[], repos: () => Promise<string[]>): void {
    this.#repoList = repos;
    const wanted = new Map<string, WatchTarget>();
    for (const m of monitors) {
      const everySeconds = m.watchSeconds ?? DEFAULT_WATCH_SECONDS;
      if (everySeconds > 0) wanted.set(m.id, { monitorId: m.id, cwd: m.cwd, everySeconds });
    }
    for (const id of [...this.#timers.keys()]) if (!wanted.has(id)) this.#drop(id);
    for (const [id, t] of wanted) {
      const current = this.#targets.get(id);
      if (current && current.everySeconds === t.everySeconds && current.cwd === t.cwd) continue;
      this.#drop(id);
      this.#targets.set(id, t);
      const timer = setInterval(() => void this.poll(id), Math.max(15, t.everySeconds) * 1000);
      (timer as { unref?: () => void }).unref?.();
      this.#timers.set(id, timer);
      void this.poll(id);
    }
  }

  stop(): void {
    for (const id of [...this.#timers.keys()]) this.#drop(id);
  }

  poll(monitorId: string): Promise<void> {
    const running = this.#inflight.get(monitorId);
    if (running) return running;
    const p = this.#poll(monitorId).finally(() => this.#inflight.delete(monitorId));
    this.#inflight.set(monitorId, p);
    return p;
  }

  #drop(id: string): void {
    const t = this.#timers.get(id);
    if (t) clearInterval(t);
    this.#timers.delete(id);
    this.#targets.delete(id);
    this.#facts.delete(id);
    this.#repos.delete(id);
  }

  async #poll(monitorId: string): Promise<void> {
    const target = this.#targets.get(monitorId);
    if (!target) return;
    let repos: string[];
    try {
      repos = await this.#reposFor(target);
    } catch (e) {
      this.#onError(monitorId, (e as Error).message);
      return;
    }
    const known = this.#facts.get(monitorId) ?? new Map<string, Map<string, PrFacts>>();
    for (const repo of [...known.keys()]) if (!repos.includes(repo)) known.delete(repo);
    const changes: PrChange[] = [];
    for (const repo of repos) {
      let next: Map<string, PrFacts>;
      try {
        next = parseWatchList(await this.#list(repo), repo);
      } catch (e) {
        // A repo that didn't answer keeps what it had, so its PRs don't read as closed.
        this.#onError(monitorId, `${repo}: ${(e as Error).message}`);
        continue;
      }
      const prev = known.get(repo);
      known.set(repo, next);
      if (prev) changes.push(...diffFacts(prev, next));
    }
    this.#facts.set(monitorId, known);
    if (changes.length)
      this.#onChange(
        monitorId,
        changes.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number),
      );
  }

  async #reposFor(target: WatchTarget): Promise<string[]> {
    const listed = await this.#repoList();
    if (listed.length) return listed;
    let repo = this.#repos.get(target.monitorId);
    if (!repo) {
      repo = (await this.#gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], target.cwd)).trim();
      this.#repos.set(target.monitorId, repo);
    }
    return [repo];
  }

  #list(repo: string): Promise<string> {
    return this.#gh([
      'pr',
      'list',
      '-R',
      repo,
      '--author',
      '@me',
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      WATCH_FIELDS.join(','),
    ]);
  }
}
