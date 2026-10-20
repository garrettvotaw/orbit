import { readFileSync, watch } from 'node:fs';
import path from 'node:path';
import type { MonitorConfig, PrBoard, PrLane, PrStageState } from '../shared/types.ts';

interface RawLane {
  pr?: number;
  title?: string;
  story?: string | null;
  bucket?: string;
  status?: string;
  note?: string | null;
  stages?: Record<string, { state?: string; label?: string }>;
}

interface RawState {
  updatedAt?: string;
  repo?: string;
  lanes?: RawLane[];
  activity?: Array<{ at?: string; text?: string }>;
}

const STAGE_STATES = new Set<PrStageState>(['good', 'busy', 'warn', 'bad', 'pending']);

export function prUrl(repo: string | null, number: number): string {
  return repo ? `https://github.com/${repo}/pull/${number}` : `#${number}`;
}

/** Shape the monitor's state.json into a PrBoard. Tolerates missing fields and bad JSON. */
export function parsePrState(json: string, monitorId: string, now: number): PrBoard {
  let raw: RawState = {};
  try {
    raw = JSON.parse(json) as RawState;
  } catch {
    return { monitorId, fetchedAt: now, repo: null, lanes: [], activity: [] };
  }
  const repo = raw.repo ?? null;
  const lanes: PrLane[] = (raw.lanes ?? [])
    .filter((l) => typeof l.pr === 'number')
    .map((l) => ({
      number: l.pr as number,
      title: l.title ?? '',
      story: l.story ?? null,
      bucket: l.bucket ?? 'unknown',
      status: l.status ?? '',
      note: l.note ?? null,
      url: prUrl(repo, l.pr as number),
      stages: Object.fromEntries(
        Object.entries(l.stages ?? {}).map(([k, v]) => [
          k,
          {
            state: STAGE_STATES.has(v.state as PrStageState) ? (v.state as PrStageState) : 'pending',
            label: v.label ?? '',
          },
        ]),
      ),
    }));
  const activity = (raw.activity ?? [])
    .map((a) => ({ at: Date.parse(a.at ?? '') || 0, text: a.text ?? '' }))
    .filter((a) => a.text)
    .slice(-20);
  const fetchedAt = Date.parse(raw.updatedAt ?? '') || now;
  return { monitorId, fetchedAt, repo, lanes, activity };
}

/** Reads each monitor's state file and re-reads it whenever it changes. */
export class PrBoardReader {
  readonly #boards = new Map<string, PrBoard>();
  readonly #watchers = new Map<string, { close(): void }>();
  #monitors: MonitorConfig[] = [];
  readonly #onBoards: (boards: PrBoard[]) => void;
  readonly #now: () => number;

  constructor(onBoards: (boards: PrBoard[]) => void, now: () => number = Date.now) {
    this.#onBoards = onBoards;
    this.#now = now;
  }

  boards(): PrBoard[] {
    return this.#monitors.map(
      (m) => this.#boards.get(m.id) ?? { monitorId: m.id, fetchedAt: 0, repo: null, lanes: [], activity: [] },
    );
  }

  setMonitors(monitors: MonitorConfig[]): void {
    this.#monitors = monitors;
    for (const [id, w] of this.#watchers) {
      if (!monitors.some((m) => m.id === id)) {
        w.close();
        this.#watchers.delete(id);
        this.#boards.delete(id);
      }
    }
    for (const m of monitors) {
      this.refresh(m.id);
      if (this.#watchers.has(m.id)) continue;
      try {
        let timer: NodeJS.Timeout | null = null;
        const w = watch(path.dirname(m.stateFile), (_ev, name) => {
          if (name !== path.basename(m.stateFile)) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => this.refresh(m.id), 300);
        });
        this.#watchers.set(m.id, w);
      } catch {
        // directory does not exist yet; refresh() on tick still works
      }
    }
    this.#onBoards(this.boards());
  }

  refresh(monitorId: string): void {
    const m = this.#monitors.find((x) => x.id === monitorId);
    if (!m) return;
    let json = '';
    try {
      json = readFileSync(m.stateFile, 'utf8');
    } catch {
      this.#boards.delete(monitorId);
      this.#onBoards(this.boards());
      return;
    }
    this.#boards.set(monitorId, parsePrState(json, monitorId, this.#now()));
    this.#onBoards(this.boards());
  }

  stop(): void {
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
  }
}
