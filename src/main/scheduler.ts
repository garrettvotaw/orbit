import type { Lane, MonitorConfig } from '../shared/types.ts';

export interface SchedulerHost {
  isLive(laneId: string): boolean;
  lane(laneId: string): Lane | undefined;
  send(laneId: string, text: string, priority: 'now' | 'next'): boolean;
  setNextTick(laneId: string, at: number | null): void;
}

export const TICK_TEXT = 'tick';

/** A tick, with what moved since the monitor's last sweep when the watcher saw anything. */
export function tickText(lines: string[]): string {
  return lines.length ? [TICK_TEXT, 'GitHub changed since your last sweep:', ...lines].join('\n') : TICK_TEXT;
}

/** A tick goes out only to a live, idle monitor; a working one is skipped, never queued. */
export function shouldTick(lane: Lane | undefined, live: boolean): boolean {
  return !!lane && live && lane.status === 'idle';
}

/** Feeds "tick" turns to monitor lanes on their configured cadence, and sooner when asked to wake one. */
export class Scheduler {
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #pending = new Map<string, string[]>();
  #flushing = false;
  readonly #host: SchedulerHost;
  readonly #now: () => number;
  readonly #setInterval: typeof setInterval;
  readonly #clearInterval: typeof clearInterval;
  readonly #onTick: (laneId: string) => void;

  constructor(deps: {
    host: SchedulerHost;
    now?: () => number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    onTick?: (laneId: string) => void;
  }) {
    this.#host = deps.host;
    this.#now = deps.now ?? Date.now;
    this.#setInterval = deps.setInterval ?? setInterval;
    this.#clearInterval = deps.clearInterval ?? clearInterval;
    this.#onTick = deps.onTick ?? (() => {});
  }

  setMonitors(monitors: MonitorConfig[]): void {
    for (const [id, t] of this.#timers) {
      if (!monitors.some((m) => m.id === id)) {
        this.#clearInterval(t);
        this.#timers.delete(id);
        this.#pending.delete(id);
        this.#host.setNextTick(id, null);
      }
    }
    for (const m of monitors) {
      if (this.#timers.has(m.id)) continue;
      const every = Math.max(1, m.everyMinutes) * 60_000;
      const t = this.#setInterval(() => this.#tick(m.id, every), every);
      (t as { unref?: () => void }).unref?.();
      this.#timers.set(m.id, t);
      this.#host.setNextTick(m.id, this.#now() + every);
    }
  }

  stop(): void {
    for (const t of this.#timers.values()) this.#clearInterval(t);
    this.#timers.clear();
    this.#pending.clear();
  }

  /**
   * Send a monitor an out-of-schedule tick saying what moved. A busy monitor gets it as soon as
   * it is idle again, with everything that piled up meanwhile; a stopped one is left alone.
   */
  wake(laneId: string, lines: string[]): void {
    if (!this.#timers.has(laneId) || !this.#host.isLive(laneId)) return;
    const queued = [...(this.#pending.get(laneId) ?? []), ...lines];
    this.#pending.set(laneId, queued);
    this.flush(laneId);
  }

  /** Deliver anything waiting for lanes that are idle now. Call when lane states change. */
  flush(laneId?: string): void {
    // Sending makes the host report a change, which lands back here; one pass at a time.
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      for (const id of laneId ? [laneId] : [...this.#pending.keys()]) {
        if (!this.#pending.get(id)?.length) continue;
        if (!shouldTick(this.#host.lane(id), this.#host.isLive(id))) continue;
        this.#deliver(id);
      }
    } finally {
      this.#flushing = false;
    }
  }

  #tick(laneId: string, every: number): void {
    this.#host.setNextTick(laneId, this.#now() + every);
    if (!shouldTick(this.#host.lane(laneId), this.#host.isLive(laneId))) return;
    this.#deliver(laneId);
  }

  /** One tick with whatever was waiting; the lines leave the queue before the send so a re-entrant flush cannot resend them. */
  #deliver(laneId: string): void {
    const lines = this.#pending.get(laneId) ?? [];
    this.#pending.delete(laneId);
    if (this.#host.send(laneId, tickText(lines), 'next')) this.#onTick(laneId);
    else if (lines.length) this.#pending.set(laneId, [...lines, ...(this.#pending.get(laneId) ?? [])]);
  }
}
