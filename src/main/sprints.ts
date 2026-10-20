import type { SprintSky, SprintWindow } from '../shared/types.ts';

/** The sprint a moment falls in; where windows overlap, the one that started last. */
export function windowOf(windows: SprintWindow[], at: number): SprintWindow | null {
  return windows.filter((w) => w.start <= at && at < w.finish).sort((a, b) => b.start - a.start)[0] ?? null;
}

/** The sprint holding now, and the last one that finished before it began (or before now, between sprints). */
export function sprintSky(windows: SprintWindow[], now: number): SprintSky {
  const current = windowOf(windows, now);
  const edge = current?.start ?? now;
  const previous = windows.filter((w) => w.finish <= edge).sort((a, b) => b.finish - a.finish)[0] ?? null;
  return { current, previous };
}

/** A moment's local day as `YYYY-MM-DD`, the way WIQL and GitHub search take a date. */
export function dayOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
