import type { GuardView, Lane, MemoryState } from '../../../../shared/types.ts';
import { formatElapsed, formatGb } from '../../../../shared/guard-format.ts';

export interface PanelRow {
  kind: 'slot' | 'wait';
  /** The story number for a moon, the lane's name otherwise. */
  who: string;
  what: string;
}

/** The memory line on the corner panel. */
export function formatFree(bytes: number, state: MemoryState): string {
  return `${formatGb(bytes)} free${state === 'holding' ? ' · holding' : ''}`;
}

/** How much of the bar is lit: the share of installed memory still free. */
export function barFraction(g: GuardView): number {
  return g.totalBytes > 0 ? Math.min(1, g.headroomBytes / g.totalBytes) : 0;
}

/** Bar colour by state: green, amber while holding, red when almost out. */
export function memoryColor(state: MemoryState): string {
  return state === 'critical' ? '#ef4444' : state === 'holding' ? '#f59e0b' : '#2fb344';
}

/** Who holds each slot and for how long, then who is in line, in order. */
export function panelRows(g: GuardView, lanes: Lane[], now: number): PanelRow[] {
  const byId = new Map(lanes.map((l) => [l.id, l]));
  const who = (laneId: string) => {
    const lane = byId.get(laneId);
    return lane?.story?.storyId ?? lane?.name ?? laneId;
  };
  return [
    ...g.slots.map((s) => ({
      kind: 'slot' as const,
      who: who(s.laneId),
      what: `${s.label} · ${formatElapsed(now - s.startedAt)}`,
    })),
    ...g.waiting.map((w) => ({
      kind: 'wait' as const,
      who: who(w.laneId),
      what: w.reason === 'memory' ? 'held for memory' : 'in line',
    })),
  ];
}

/** The word under a moon's number while it is in the line. */
export function guardFact(laneId: string, g: GuardView): 'testing' | 'in line' | 'held' | null {
  const mark = orbMark(laneId, g);
  if (mark === 'testing') return 'testing';
  if (!mark) return null;
  return g.waiting.some((w) => w.laneId === laneId && w.reason === 'memory') ? 'held' : 'in line';
}

/** What a lane's orb shows: a ring while it holds a slot, a dashed one while it waits. */
export function orbMark(laneId: string, g: GuardView): 'testing' | 'waiting' | null {
  if (g.slots.some((s) => s.laneId === laneId)) return 'testing';
  if (g.waiting.some((w) => w.laneId === laneId)) return 'waiting';
  return null;
}
