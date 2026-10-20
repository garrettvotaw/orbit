import type { ProjectConfig, TrackerConfig } from '../../shared/types.ts';
import type { GhRunner } from '../github.ts';
import { AdoAdapter, type AdoClient } from './ado.ts';
import { trackerOf } from './config.ts';
import { GitHubIssuesAdapter } from './github-issues.ts';
import { JiraAdapter, type JiraClient } from './jira.ts';
import type { Tracker } from './tracker.ts';

/** How each kind of tracker talks to its service: one ADO client, one Jira client per site, gh. */
export interface TrackerDeps {
  ado: AdoClient;
  jira: (site: string) => JiraClient;
  gh: GhRunner;
}

export function trackerFor(cfg: TrackerConfig, deps: TrackerDeps): Tracker {
  if (cfg.kind === 'ado') return new AdoAdapter(cfg, deps.ado);
  if (cfg.kind === 'jira') return new JiraAdapter(cfg, deps.jira(cfg.site));
  return new GitHubIssuesAdapter(cfg, deps.gh);
}

/** One adapter per project with a tracker, rebuilt only when that project's tracker config changes. */
export class TrackerRegistry {
  readonly #deps: TrackerDeps;
  #built = new Map<string, { key: string; tracker: Tracker }>();

  constructor(deps: TrackerDeps) {
    this.#deps = deps;
  }

  setProjects(projects: ProjectConfig[]): void {
    const next = new Map<string, { key: string; tracker: Tracker }>();
    for (const p of projects) {
      const cfg = trackerOf(p);
      if (!cfg) continue;
      const key = JSON.stringify(cfg);
      const prev = this.#built.get(p.id);
      next.set(p.id, prev?.key === key ? prev : { key, tracker: trackerFor(cfg, this.#deps) });
    }
    this.#built = next;
  }

  for(projectId: string): Tracker | null {
    return this.#built.get(projectId)?.tracker ?? null;
  }
}
