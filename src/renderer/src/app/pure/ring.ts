import type { PrLane, TrackerBoard } from '../../../../shared/types.ts';

export interface SegmentSpec {
  key: string;
  label: string;
  color: string;
}

export interface RingSegment extends SegmentSpec {
  count: number;
  /** Arc start and length along the circumference, in px, from 12 o'clock clockwise. */
  start: number;
  length: number;
  dasharray: string;
  dashoffset: number;
}

export interface RingDot {
  id: string;
  title: string;
  color: string;
  url: string;
  x: number;
  y: number;
}

/** In the order the PR table lists them: what needs you first. */
export const PR_BUCKETS: SegmentSpec[] = [
  { key: 'attention', label: 'Needs you', color: '#f97316' },
  { key: 'green', label: 'Green', color: '#2fb344' },
  { key: 'ready', label: 'Ready', color: '#10b981' },
  { key: 'fixing', label: 'Fixing', color: '#ffd27a' },
  { key: 'blocked', label: 'Blocked', color: '#ef4444' },
  { key: 'waiting', label: 'Waiting on review', color: '#3b82f6' },
];

/** Statuses we have no colour for still show, by their real name, in grey. */
const UNKNOWN_COLOR = '#9aa3b2';

/** Merged PRs are history, not work on the ring. */
export const PR_HIDDEN_BUCKETS = new Set(['merged', 'closed']);

/** Group items into the ordered segments; each unlisted key gets its own after them, in the order first seen. */
export function groupBy<T>(
  items: T[],
  keyOf: (t: T) => string,
  order: SegmentSpec[],
  labelOf: (key: string) => string = (key) => key,
): Array<SegmentSpec & { items: T[] }> {
  const groups = new Map(order.map((s) => [s.key, { ...s, items: [] as T[] }]));
  for (const it of items) {
    const key = keyOf(it);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: labelOf(key), color: UNKNOWN_COLOR, items: [] };
      groups.set(key, g);
    }
    g.items.push(it);
  }
  return [...groups.values()].filter((g) => g.items.length);
}

/** Lay groups out as dash arcs on a circle of the given radius. */
export function ringSegments(
  groups: Array<SegmentSpec & { items: unknown[] }>,
  radius: number,
  gapPx = 3,
): RingSegment[] {
  const circ = 2 * Math.PI * radius;
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) return [];
  const gap = groups.length > 1 ? gapPx : 0;
  let cursor = 0;
  return groups.map((g) => {
    const span = (g.items.length / total) * circ;
    const length = Math.max(0, span - gap);
    const start = cursor + gap / 2;
    cursor += span;
    return {
      key: g.key,
      label: g.label,
      color: g.color,
      count: g.items.length,
      start,
      length,
      dasharray: `${length.toFixed(2)} ${(circ - length).toFixed(2)}`,
      dashoffset: Number((-start).toFixed(2)),
    };
  });
}

/** One dot per item, spaced evenly inside its segment's arc. */
export function ringDots<T>(
  groups: Array<SegmentSpec & { items: T[] }>,
  segments: RingSegment[],
  radius: number,
  dotOf: (t: T) => { id: string; title: string; url: string },
): RingDot[] {
  const circ = 2 * Math.PI * radius;
  const out: RingDot[] = [];
  groups.forEach((g, gi) => {
    const seg = segments[gi];
    if (!seg) return;
    g.items.forEach((it, i) => {
      const along = seg.start + ((i + 0.5) / g.items.length) * seg.length;
      const angle = (along / circ) * 2 * Math.PI - Math.PI / 2;
      const d = dotOf(it);
      out.push({
        ...d,
        color: seg.color,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    });
  });
  return out;
}

/** A board's columns as ring segments, in the tracker's order and colours; a column it doesn't list shows grey after them. */
export function boardGroups(board: TrackerBoard | null) {
  if (!board) return [];
  const order = board.columns.map((c) => ({ key: c.name, label: c.name, color: c.color }));
  return groupBy(board.items, (i) => i.column, order);
}

export { mentionsKey } from '../../../../shared/keys.ts';

export function prGroups(lanes: PrLane[]) {
  return groupBy(
    lanes.filter((l) => !PR_HIDDEN_BUCKETS.has(l.bucket)),
    (l) => l.bucket,
    PR_BUCKETS,
    (key) => key.charAt(0).toUpperCase() + key.slice(1),
  );
}

/** The PR monitor's line: how many are open, then each bucket that has any, by its real name. */
export function prSummary(lanes: PrLane[]): string {
  const groups = prGroups(lanes);
  const open = groups.reduce((n, g) => n + g.items.length, 0);
  return [`${open} open`, ...groups.map((g) => `${g.label.toLowerCase()} ${g.items.length}`)].join(
    ' · ',
  );
}

const PARKED_SCALE = 0.45;

/** Where every core sits: spread on the baseline at home, or one focused core with the rest parked small. */
export function stageLayout(
  count: number,
  selectedIndex: number | null,
  boardOpen: boolean,
  width: number,
  height: number,
  /** Home-row slot for each lane; defaults to config order. */
  slots: number[] = Array.from({ length: count }, (_, i) => i),
  /** How far each lane reaches from its centre at full size, its moons included. */
  reach: number[] = [],
): Array<{ x: number; y: number; scale: number }> {
  if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= count) {
    const step = width / (count + 1);
    return Array.from({ length: count }, (_, i) => ({
      x: Math.round(step * ((slots[i] ?? i) + 1)),
      y: Math.round(height * 0.55),
      scale: 1,
    }));
  }
  const focusX = Math.round(width * (boardOpen ? 0.17 : 0.28));
  const focusY = Math.round(height * 0.5);
  // Parked lanes sit 72px apart, or further when their moons would otherwise touch.
  let x = 0;
  let prev: number | null = null;
  return Array.from({ length: count }, (_, i) => {
    if (i === selectedIndex) return { x: focusX, y: focusY, scale: 1.7 };
    x =
      prev === null ? 56 : x + Math.max(72, ((reach[prev] ?? 0) + (reach[i] ?? 0)) * PARKED_SCALE);
    prev = i;
    return { x: Math.round(x), y: Math.round(height - 56), scale: PARKED_SCALE };
  });
}

export const STALE_AFTER_MS = 2 * 60 * 60_000;

/** An idle project that has not reported in two hours is quietly stale. */
export function isStale(
  status: string,
  startedAt: number | null,
  lastReportAt: number | null,
  now: number,
): boolean {
  if (status !== 'idle' || startedAt === null) return false;
  const since = lastReportAt ?? startedAt;
  return now - since > STALE_AFTER_MS;
}
