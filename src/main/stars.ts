import { mentionsKey } from '../shared/keys.ts';
import type { ProjectConfig, SprintSky, SprintWindow, Star, TrackerItem } from '../shared/types.ts';
import { RowTable, type Db } from './db.ts';
import type { MergedPr } from './github.ts';
import type { RepoResolver } from './repos.ts';
import { dayOf, sprintSky, windowOf } from './sprints.ts';
import type { TrackerRegistry } from './trackers/registry.ts';
import type { Tracker } from './trackers/tracker.ts';

/** The stars table, one row per merged PR per PM, field for field with `Star`. */
export function starRows(db: Db): RowTable<Star> {
  return new RowTable<Star>(db, 'stars', ['id', 'pmId', 'storyId', 'title', 'pr', 'prUrl', 'sprint', 'at']);
}

/** Lower id first: as numbers when both are (ADO, GitHub), else as text (Jira keys). */
function lowerId(a: TrackerItem, b: TrackerItem): number {
  const [x, y] = [Number(a.id), Number(b.id)];
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : a.id.localeCompare(b.id, undefined, { numeric: true });
}

const repoOfUrl = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(url)?.[1]?.toLowerCase() ?? null;

/**
 * The stories a merged PR belongs to, by the first rule that finds any: the tracker linked it
 * (ADO artifact links, GitHub closing references); its title, branch, or body names the story's
 * key (Jira, which links nothing itself); or a story moon opened it.
 */
function storiesFor(
  pr: MergedPr,
  items: TrackerItem[],
  moonPrs: Array<{ storyId: string; pr: number }>,
  linkByKey: boolean,
): TrackerItem[] {
  const repo = repoOfUrl(pr.url);
  const linked = items.filter((i) =>
    i.prs.some((p) => p.number === pr.number && (p.repo === null || p.repo.toLowerCase() === repo)),
  );
  if (linked.length) return linked;
  if (linkByKey) {
    const text = `${pr.title} ${pr.branch} ${pr.body}`;
    const named = items.filter((i) => mentionsKey(text, i.key));
    if (named.length) return named;
  }
  const moon = new Set(moonPrs.filter((m) => m.pr === pr.number).map((m) => m.storyId));
  return items.filter((i) => moon.has(i.id));
}

/**
 * One star for every merged PR on one of a PM's stories, stamped when it merged and placed in the
 * sprint whose window holds that moment; a PR claimed by two stories lands on the lower id. A PM
 * whose tracker has no sprints still gets its stars, with no sprint.
 */
export function starsFor(
  pmId: string,
  items: TrackerItem[],
  merged: MergedPr[],
  windows: SprintWindow[],
  moonPrs: Array<{ storyId: string; pr: number }>,
  linkByKey: boolean,
): Star[] {
  const out: Star[] = [];
  for (const pr of merged) {
    const sprint = windowOf(windows, pr.mergedAt);
    if (windows.length && !sprint) continue;
    const story = storiesFor(pr, items, moonPrs, linkByKey).sort(lowerId)[0];
    if (!story) continue;
    out.push({
      id: `${pmId}-pr-${pr.number}`,
      pmId,
      storyId: story.id,
      title: story.title,
      pr: pr.number,
      prUrl: pr.url,
      sprint: sprint?.path ?? null,
      at: pr.mergedAt,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** How far back to look when a tracker has no sprints to say: two three-week sprints. */
const FALLBACK_LOOKBACK_MS = 42 * 24 * 3_600_000;

export interface StarWatcherDeps {
  trackers: Pick<TrackerRegistry, 'for'>;
  repos: Pick<RepoResolver, 'repoFor'>;
  merged: (repo: string, since: string) => Promise<MergedPr[]>;
  /** The PRs this PM's story moons opened, by story. */
  moonPrs: (pmId: string) => Array<{ storyId: string; pr: number }>;
  now?: () => number;
  onStars: (stars: Star[]) => void;
  onError?: (message: string) => void;
}

/** One PM's part of a refresh: its tracker, its sprints, and how far back its stars reach. */
interface PmPlan {
  pmId: string;
  tracker: Tracker;
  windows: SprintWindow[];
  since: string;
  repo: string | null;
}

/**
 * Keeps every PM's sky and stars current: its own sprint windows from its own tracker, its
 * stories, and the PRs merged in its repo since its previous sprint began. GitHub is asked once
 * per repo, from the earliest of those days.
 */
export class StarWatcher {
  readonly #deps: StarWatcherDeps;
  #projects: ProjectConfig[] = [];
  #skies: Record<string, SprintSky> = {};
  #inflight: Promise<void> | null = null;

  constructor(deps: StarWatcherDeps) {
    this.#deps = deps;
  }

  skies(): Record<string, SprintSky> {
    return this.#skies;
  }

  setProjects(projects: ProjectConfig[]): void {
    this.#projects = projects;
  }

  refresh(): Promise<void> {
    this.#inflight ??= this.#refresh().finally(() => (this.#inflight = null));
    return this.#inflight;
  }

  async #refresh(): Promise<void> {
    const now = (this.#deps.now ?? Date.now)();
    const plans = (await Promise.all(this.#projects.map((p) => this.#plan(p, now)))).filter((x) => x !== null);
    const merged = await this.#mergedByRepo(plans);
    const stars: Star[] = [];
    for (const plan of plans) {
      try {
        const items = await plan.tracker.shipped(plan.since);
        const prs = plan.repo ? (merged.get(plan.repo) ?? []) : [];
        const linkByKey = plan.tracker.ref.kind === 'jira';
        stars.push(...starsFor(plan.pmId, items, prs, plan.windows, this.#deps.moonPrs(plan.pmId), linkByKey));
      } catch (e) {
        this.#deps.onError?.(`${plan.pmId}: ${(e as Error).message}`);
      }
    }
    this.#deps.onStars(stars.sort((a, b) => a.at - b.at));
  }

  async #plan(p: ProjectConfig, now: number): Promise<PmPlan | null> {
    const tracker = this.#deps.trackers.for(p.id);
    if (!tracker) return null;
    try {
      const windows = await tracker.sprints();
      const sky = sprintSky(windows, now);
      this.#skies = { ...this.#skies, [p.id]: sky };
      const since = dayOf(sky.previous?.start ?? sky.current?.start ?? now - FALLBACK_LOOKBACK_MS);
      return { pmId: p.id, tracker, windows, since, repo: await this.#deps.repos.repoFor(p.id) };
    } catch (e) {
      this.#deps.onError?.(`${p.id}: ${(e as Error).message}`);
      return null;
    }
  }

  async #mergedByRepo(plans: PmPlan[]): Promise<Map<string, MergedPr[]>> {
    const since = new Map<string, string>();
    for (const { repo, since: day } of plans) {
      if (repo && (!since.has(repo) || day < since.get(repo)!)) since.set(repo, day);
    }
    const out = new Map<string, MergedPr[]>();
    await Promise.all(
      [...since].map(async ([repo, day]) => {
        try {
          out.set(repo, await this.#deps.merged(repo, day));
        } catch (e) {
          this.#deps.onError?.(`${repo}: ${(e as Error).message}`);
        }
      }),
    );
    return out;
  }
}

/** Every star Orbit has handed out, kept so each sprint's constellation outlives ADO's links and GitHub's search. */
export class StarStore {
  #list: Star[];
  readonly #rows: RowTable<Star>;
  readonly #listeners = new Set<() => void>();

  constructor(db: Db) {
    this.#rows = starRows(db);
    this.#list = this.#rows.all('at');
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  list(): Star[] {
    return [...this.#list];
  }

  add(stars: Star[]): void {
    const fresh = stars.filter((s) => !this.#list.some((k) => k.id === s.id));
    if (!fresh.length) return;
    this.#list = [...this.#list, ...fresh].sort((a, b) => a.at - b.at);
    this.#rows.put(fresh);
    for (const cb of this.#listeners) cb();
  }
}
