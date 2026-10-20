import type { ProjectConfig, TrackerBoard, TrackerRef } from '../../shared/types.ts';
import type { TrackerRegistry } from './registry.ts';
import { TrackerAuthError } from './tracker.ts';

export interface TrackerPollerDeps {
  trackers: Pick<TrackerRegistry, 'for'>;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** A sign-in lapsed: once per ref while it lasts, on the first project in config order that uses it. */
  onAuthError: (projectId: string, ref: TrackerRef, message: string) => void;
  onBoards: (boards: TrackerBoard[]) => void;
}

const refKey = (ref: TrackerRef) => `${ref.kind}:${ref.site}`;

/** Keeps one board per project fresh, whatever its tracker: on a timer, on demand, and after every PM report. */
export class TrackerPoller {
  readonly #boards = new Map<string, TrackerBoard>();
  readonly #deps: Required<Omit<TrackerPollerDeps, 'trackers'>> & Pick<TrackerPollerDeps, 'trackers'>;
  #projects: ProjectConfig[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  /** Refs whose card is up: raised again only after a fetch on that ref succeeds. */
  readonly #raised = new Set<string>();
  readonly #inflight = new Set<string>();

  constructor(deps: TrackerPollerDeps) {
    this.#deps = { now: Date.now, setInterval, clearInterval, ...deps };
  }

  boards(): TrackerBoard[] {
    return this.#projects.map((p) => this.#boards.get(p.id) ?? this.#empty(p.id));
  }

  board(projectId: string): TrackerBoard | null {
    if (!this.#projects.some((p) => p.id === projectId)) return null;
    return this.#boards.get(projectId) ?? this.#empty(projectId);
  }

  setProjects(projects: ProjectConfig[], pollMinutes: number): void {
    this.#projects = projects;
    for (const id of [...this.#boards.keys()]) if (!projects.some((p) => p.id === id)) this.#boards.delete(id);
    if (this.#timer) this.#deps.clearInterval(this.#timer);
    this.#timer = this.#deps.setInterval(() => this.refreshAll(), Math.max(1, pollMinutes) * 60_000);
    (this.#timer as { unref?: () => void }).unref?.();
    void this.refreshAll();
  }

  /** Lets this sign-in's card come up again: after a new token is saved, a 401 should say so. */
  forget(ref: TrackerRef): void {
    this.#raised.delete(refKey(ref));
  }

  stop(): void {
    if (this.#timer) this.#deps.clearInterval(this.#timer);
    this.#timer = null;
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.#projects.map((p) => this.refresh(p.id)));
  }

  async refresh(projectId: string): Promise<void> {
    const tracker = this.#deps.trackers.for(projectId);
    if (!this.#projects.some((p) => p.id === projectId) || !tracker || this.#inflight.has(projectId)) return;
    this.#inflight.add(projectId);
    const prev = this.#boards.get(projectId) ?? this.#empty(projectId);
    try {
      const { columns, items } = await tracker.board();
      const fresh = { projectId, tracker: tracker.ref, fetchedAt: this.#deps.now(), columns, items };
      this.#boards.set(projectId, { ...fresh, stale: false, error: null });
      this.#raised.delete(refKey(tracker.ref));
    } catch (e) {
      const message = (e as Error).message;
      this.#boards.set(projectId, { ...prev, tracker: tracker.ref, stale: true, error: message });
      if (e instanceof TrackerAuthError) this.#raise(e.ref, message, projectId);
    } finally {
      this.#inflight.delete(projectId);
      this.#deps.onBoards(this.boards());
    }
  }

  #raise(ref: TrackerRef, message: string, fallback: string): void {
    const key = refKey(ref);
    if (this.#raised.has(key)) return;
    this.#raised.add(key);
    const first = this.#projects.find((p) => {
      const t = this.#deps.trackers.for(p.id);
      return t !== null && refKey(t.ref) === key;
    });
    this.#deps.onAuthError(first?.id ?? fallback, ref, message);
  }

  #empty(projectId: string): TrackerBoard {
    const tracker = this.#deps.trackers.for(projectId)?.ref ?? null;
    return { projectId, tracker, fetchedAt: 0, columns: [], items: [], stale: false, error: null };
  }
}
