import type { SlotView, WaitView } from '../shared/types.ts';

export interface SlotRequest {
  laneId: string;
  agentId: string | null;
  toolUseId: string;
  label: string;
  /** Started with run_in_background, so it ends with a task notification rather than PostToolUse. */
  background: boolean;
}

interface Held {
  req: SlotRequest;
  startedAt: number;
  background: boolean;
  taskId: string | null;
}

interface Waiter {
  req: SlotRequest;
  since: number;
  settle: (granted: boolean) => void;
}

/** A slot whose end Orbit never heard about is freed after this long; Bash in the foreground tops out at 10 minutes. */
const FOREGROUND_MAX_MS = 15 * 60_000;
const BACKGROUND_MAX_MS = 45 * 60_000;

/**
 * The one line every lane's heavy commands share. A command waits, first come first served, until
 * fewer than the limit are running, then holds a slot until Orbit hears it ended. Low memory cuts
 * the limit below `base` for a while.
 */
export class TestSlots {
  readonly #base: number;
  readonly #now: () => number;
  readonly #held = new Map<string, Held>();
  readonly #waiting: Waiter[] = [];
  readonly #listeners = new Set<() => void>();
  #cut: number | null = null;

  constructor(o: { base: number; now?: () => number }) {
    this.#base = o.base;
    this.#now = o.now ?? Date.now;
  }

  get #limit(): number {
    return Math.min(this.#base, this.#cut ?? this.#base);
  }

  /** Wait for a slot: true once it is this command's, false if the wait was aborted or its lane dropped. */
  acquire(req: SlotRequest, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        const i = this.#waiting.indexOf(waiter);
        if (i < 0) return;
        this.#waiting.splice(i, 1);
        resolve(false);
        this.#emit();
      };
      const waiter: Waiter = {
        req,
        since: this.#now(),
        settle: (granted) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(granted);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(waiter);
      this.#grant();
      this.#emit();
    });
  }

  /** Low memory's cap on the slots, or null to lift it. */
  cut(limit: number | null): void {
    if (this.#cut === limit) return;
    this.#cut = limit;
    this.#grant();
    this.#emit();
  }

  /** PostToolUse: a foreground command ended. A background one keeps its slot until its task ends. */
  finish(toolUseId: string): void {
    const slot = this.#held.get(toolUseId);
    if (!slot || slot.background) return;
    this.#free(toolUseId);
  }

  /** The command moved to the background, so only its task's end frees the slot. */
  background(toolUseId: string, taskId?: string): void {
    const slot = this.#held.get(toolUseId);
    if (!slot) return;
    slot.background = true;
    if (taskId) slot.taskId = taskId;
  }

  /** The task id the CLI gave the command, for matching the background level signal. */
  task(toolUseId: string, taskId: string): void {
    const slot = this.#held.get(toolUseId);
    if (slot) slot.taskId = taskId;
  }

  /** A task notification: the command ended, however it ran. */
  taskEnded(toolUseId: string): void {
    if (this.#held.has(toolUseId)) this.#free(toolUseId);
  }

  /** A lane's live background tasks: any of its background slots whose task is gone is freed. */
  liveTasks(laneId: string, taskIds: string[]): void {
    const gone = [...this.#held]
      .filter(([, s]) => s.req.laneId === laneId && s.background && s.taskId && !taskIds.includes(s.taskId))
      .map(([id]) => id);
    for (const id of gone) this.#held.delete(id);
    if (gone.length) this.#settle();
  }

  /** Whether this command holds a slot now. */
  has(toolUseId: string): boolean {
    return this.#held.has(toolUseId);
  }

  holds(laneId: string): boolean {
    return [...this.#held.values()].some((s) => s.req.laneId === laneId);
  }

  /** The lane stopped: free its slots and turn its waiters away. */
  dropLane(laneId: string): void {
    let changed = false;
    for (const [id, s] of this.#held)
      if (s.req.laneId === laneId) {
        this.#held.delete(id);
        changed = true;
      }
    for (const w of this.#waiting.filter((x) => x.req.laneId === laneId)) {
      this.#waiting.splice(this.#waiting.indexOf(w), 1);
      w.settle(false);
      changed = true;
    }
    if (changed) this.#settle();
  }

  /** Free slots held past the longest a command could run; returns what it freed. */
  sweep(): SlotView[] {
    const now = this.#now();
    const stale = [...this.#held].filter(
      ([, s]) => now - s.startedAt > (s.background ? BACKGROUND_MAX_MS : FOREGROUND_MAX_MS),
    );
    for (const [id] of stale) this.#held.delete(id);
    if (stale.length) this.#settle();
    return stale.map(([, s]) => slotView(s));
  }

  view(): { slots: SlotView[]; waiting: WaitView[] } {
    const cutShort = this.#cut !== null && this.#held.size < this.#base;
    return {
      slots: [...this.#held.values()].map(slotView),
      waiting: this.#waiting.map((w) => ({
        laneId: w.req.laneId,
        agentId: w.req.agentId,
        label: w.req.label,
        since: w.since,
        reason: cutShort ? 'memory' : 'slot',
        kind: 'command',
      })),
    };
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #free(toolUseId: string): void {
    this.#held.delete(toolUseId);
    this.#settle();
  }

  #settle(): void {
    this.#grant();
    this.#emit();
  }

  #grant(): void {
    while (this.#held.size < this.#limit && this.#waiting.length) {
      const w = this.#waiting.shift()!;
      this.#held.set(w.req.toolUseId, {
        req: w.req,
        startedAt: this.#now(),
        background: w.req.background,
        taskId: null,
      });
      w.settle(true);
    }
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

function slotView(s: Held): SlotView {
  return {
    laneId: s.req.laneId,
    agentId: s.req.agentId,
    label: s.req.label,
    startedAt: s.startedAt,
    background: s.background,
  };
}
