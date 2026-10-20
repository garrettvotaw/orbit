import type { OrbitConfig } from '../shared/types.ts';
import type { GhRunner } from './github.ts';

/**
 * Which GitHub repo each lane's PRs go to: the project's own `githubRepo`, else the config's, else
 * whatever its folder's remote says (asked once per folder, and again if it had none).
 */
export class RepoResolver {
  readonly #gh: GhRunner;
  #cfg: OrbitConfig | null = null;
  readonly #byCwd = new Map<string, Promise<string | null>>();
  /** Each lane's repo once resolved, for folderFor. */
  readonly #byLane = new Map<string, string>();

  constructor(gh: GhRunner) {
    this.#gh = gh;
  }

  setConfig(cfg: OrbitConfig): void {
    this.#cfg = cfg;
  }

  async repoFor(projectId: string): Promise<string | null> {
    const p = this.#cfg?.projects.find((x) => x.id === projectId);
    if (!p) return null;
    return this.#remember(p.id, p.githubRepo ?? this.#cfg?.githubRepo ?? (await this.#detect(p.cwd)));
  }

  async all(): Promise<string[]> {
    const cfg = this.#cfg;
    if (!cfg) return [];
    const found: string[] = [];
    for (const p of cfg.projects) {
      const repo = await this.repoFor(p.id);
      if (repo) found.push(repo);
    }
    for (const lane of [...cfg.monitors, ...cfg.chats]) {
      const repo = this.#remember(lane.id, cfg.githubRepo ?? (await this.#detect(lane.cwd)));
      if (repo) found.push(repo);
    }
    const seen = new Set<string>();
    return found.filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
  }

  folderFor(repo: string): string | null {
    const cfg = this.#cfg;
    if (!cfg) return null;
    const lanes = [...cfg.projects, ...cfg.monitors, ...cfg.chats];
    const hit = lanes.find((l) => this.#byLane.get(l.id)?.toLowerCase() === repo.toLowerCase());
    return hit?.cwd ?? null;
  }

  #remember(laneId: string, repo: string | null): string | null {
    if (repo) this.#byLane.set(laneId, repo);
    return repo;
  }

  #detect(cwd: string): Promise<string | null> {
    let pending = this.#byCwd.get(cwd);
    if (!pending) {
      pending = this.#gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd).then(
        (out) => out.trim() || null,
        () => {
          // No remote yet (or gh is signed out): look again next time rather than never.
          this.#byCwd.delete(cwd);
          return null;
        },
      );
      this.#byCwd.set(cwd, pending);
    }
    return pending;
  }
}
