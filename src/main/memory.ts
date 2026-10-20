import type { MemoryState } from '../shared/types.ts';

const GB = 1024 ** 3;

export interface MemoryThresholds {
  /** Below this, the line drops to one slot and no new moon starts. */
  holdGb: number;
  /** Holding ends once headroom is back at this. */
  resumeGb: number;
  /** Below this, no heavy command starts at all, and a card says so. */
  criticalGb: number;
}

export const DEFAULT_THRESHOLDS: MemoryThresholds = { holdGb: 8, resumeGb: 10, criticalGb: 3 };

/** Critical ends this far above where it began. */
const CRITICAL_EXIT_GB = 1;

/**
 * What Windows can still hand out, from Electron's `process.getSystemMemoryInfo()` (in KB): the
 * lower of available physical memory, where paging starts, and free commit, which is what ran out
 * when the PC shut down. A reading with no commit figure falls back to physical.
 */
export function headroomBytes(info: { free: number; swapFree: number }): number {
  const kb = info.swapFree > 0 ? Math.min(info.free, info.swapFree) : info.free;
  return kb * 1024;
}

/** The next state for a headroom reading. Each state is left a little above where it was entered, so a reading hovering at a line doesn't flap. */
export function nextMemoryState(prev: MemoryState, headroom: number, t: MemoryThresholds): MemoryState {
  const gb = headroom / GB;
  if (gb < t.criticalGb) return 'critical';
  if (prev === 'critical' && gb < t.criticalGb + CRITICAL_EXIT_GB) return 'critical';
  if (gb < t.holdGb) return 'holding';
  if (prev !== 'normal' && gb < t.resumeGb) return 'holding';
  return 'normal';
}

/** How many heavy commands may run at once in a state. */
export function slotLimit(state: MemoryState, testSlots: number): number {
  if (state === 'critical') return 0;
  if (state === 'holding') return Math.min(1, testSlots);
  return testSlots;
}
