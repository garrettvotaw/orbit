import { execFile } from 'node:child_process';
import type { GuardView, MemoryState, SlotView } from '../shared/types.ts';
import { formatElapsed, formatGb } from '../shared/guard-format.ts';
import { headroomBytes, nextMemoryState, slotLimit, type MemoryThresholds } from './memory.ts';
import type { TestSlots } from './slots.ts';

const GB = 1024 ** 3;
const SAMPLE_MS = 5_000;
/** The panel only redraws when free memory moves at least this much. */
const SHOWN_STEP = 0.1 * GB;

export interface ProcessUse {
  name: string;
  bytes: number;
}

export interface MemoryGuardDeps {
  /** Electron's process.getSystemMemoryInfo(), in KB. */
  sample: () => { total?: number; free: number; swapFree: number };
  slots: TestSlots;
  testSlots: number;
  thresholds: MemoryThresholds;
  /** Let the launch that has waited longest go. */
  releaseHeld: () => void;
  alert: (message: string) => void;
  topProcesses: () => Promise<ProcessUse[]>;
  /** How the alert names a lane; its id otherwise. */
  nameOf?: (laneId: string) => string;
  now?: () => number;
}

/**
 * Watches free memory and keeps the test-slot line inside it: one slot when it runs low, none when
 * it's almost out, and a held moon start let go once it's back. Never stops anything itself; when
 * memory is almost out it says what is using it.
 */
export class MemoryGuard {
  readonly #d: MemoryGuardDeps;
  readonly #listeners = new Set<() => void>();
  #state: MemoryState = 'normal';
  #headroom = 0;
  #total = 0;
  #shown = Number.NaN;
  /** Whether the next critical reading raises an alert; disarmed until memory climbs back to the hold line. */
  #armed = true;

  constructor(d: MemoryGuardDeps) {
    this.#d = d;
  }

  /** Sample every few seconds until the returned stop is called. */
  start(): () => void {
    this.tick();
    const timer = setInterval(() => this.tick(), SAMPLE_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  tick(): void {
    const { slots, testSlots, thresholds } = this.#d;
    const prev = this.#state;
    const info = this.#d.sample();
    this.#headroom = headroomBytes(info);
    this.#total = (info.total ?? 0) * 1024;
    this.#state = nextMemoryState(prev, this.#headroom, thresholds);
    slots.cut(this.#state === 'normal' ? null : slotLimit(this.#state, testSlots));
    for (const s of slots.sweep()) console.warn(`Orbit: freed a test slot nobody released (${s.laneId}, ${s.label}).`);
    if (this.admits()) this.#d.releaseHeld();
    if (this.#state === 'critical' && this.#armed) {
      this.#armed = false;
      void this.#raise(this.#headroom);
    } else if (!this.#armed && this.#headroom >= thresholds.holdGb * GB) this.#armed = true;
    if (prev !== this.#state || !(Math.abs(this.#headroom - this.#shown) < SHOWN_STEP)) {
      this.#shown = this.#headroom;
      for (const l of this.#listeners) l();
    }
  }

  /** Whether a launch Orbit or a PM asked for may go now. */
  admits(): boolean {
    return this.#state === 'normal';
  }

  view(): Pick<GuardView, 'headroomBytes' | 'totalBytes' | 'state'> {
    return { headroomBytes: this.#headroom, totalBytes: this.#total, state: this.#state };
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  async #raise(headroom: number): Promise<void> {
    const top = await this.#d.topProcesses().catch(() => []);
    const now = (this.#d.now ?? Date.now)();
    this.#d.alert(criticalMessage(headroom, this.#d.slots.view().slots, top, now, this.#d.nameOf ?? ((id) => id)));
  }
}

/** The alert for memory that's almost out: what's testing, what's biggest, and that Orbit stopped nothing. */
export function criticalMessage(
  headroom: number,
  slots: SlotView[],
  top: ProcessUse[],
  now: number,
  nameOf: (laneId: string) => string,
): string {
  const parts = [`Memory is almost out (${formatGb(headroom)} free).`];
  if (slots.length)
    parts.push(
      `Tests running: ${slots.map((s) => `${nameOf(s.laneId)} ${s.label} (${formatElapsed(now - s.startedAt)})`).join(', ')}.`,
    );
  if (top.length) parts.push(`Biggest right now: ${top.map((p) => `${p.name} ${formatGb(p.bytes)}`).join(', ')}.`);
  parts.push('Nothing was stopped.');
  return parts.join(' ');
}

/** The processes using the most memory, with every copy of a program added together. */
export function topByName(rows: Array<{ Name: string; WorkingSetSize: number }>, n: number): ProcessUse[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    const name = r.Name.toLowerCase().replace(/\.exe$/, '');
    by.set(name, (by.get(name) ?? 0) + r.WorkingSetSize);
  }
  return [...by]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}

/** One look at every process on the machine, only when memory is almost out. */
export function listProcesses(): Promise<ProcessUse[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-c',
        'Get-CimInstance Win32_Process | Select-Object Name,WorkingSetSize | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          resolve(topByName(JSON.parse(stdout) as Array<{ Name: string; WorkingSetSize: number }>, 5));
        } catch {
          resolve([]);
        }
      },
    );
  });
}
