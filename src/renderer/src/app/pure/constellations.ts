import type { SprintSky, SprintWindow, Star } from '../../../../shared/types.ts';
import { galaxySpot, type KeepOut } from './galaxy.ts';
import { worldTint, type WorldKind } from './worlds.ts';

/**
 * A PR star's colour, from its PM's planet: saturated enough that it never reads as one of the
 * white background stars, and darker on the light stage so it still shows.
 */
export function starTint(kind: WorldKind, dark: boolean): string {
  return worldTint(kind, dark);
}

/** A star placed in the band. */
export interface SkyStar extends Star {
  x: number;
  y: number;
  /** The last one to land anywhere in the sky, which pulses until the next arrives. */
  newest: boolean;
}

/** One PM's stars in the band: this sprint's lit, the sprint before's faded, each oldest first. */
export interface PmGalaxy {
  pmId: string;
  lit: SkyStar[];
  faded: SkyStar[];
}

/** How recently a PR must have merged for its star to launch in; merges are looked for every few minutes. */
export const LAUNCH_FRESH_MS = 15 * 60_000;

/** A tracker with no sprints at all: back-to-back three-week windows ending now stand in for them. */
const FALLBACK_SPRINT_MS = 21 * 86_400_000;

/**
 * Without sprint windows: the PM's newest sprint by its newest star, and the one before it; and
 * when its stars name no sprint at all, the last three weeks and the three before.
 */
function newestTwo(mine: Star[], now: number): { current: Star[]; previous: Star[] } {
  if (mine.length && mine.every((s) => s.sprint === null)) {
    return {
      current: mine.filter((s) => s.at > now - FALLBACK_SPRINT_MS),
      previous: mine.filter(
        (s) => s.at <= now - FALLBACK_SPRINT_MS && s.at > now - 2 * FALLBACK_SPRINT_MS,
      ),
    };
  }
  const groups = new Map<string, Star[]>();
  for (const s of mine) groups.set(s.sprint ?? '', [...(groups.get(s.sprint ?? '') ?? []), s]);
  const newest = (g: Star[]) => Math.max(...g.map((s) => s.at));
  const [current = [], previous = []] = [...groups.values()].sort((a, b) => newest(b) - newest(a));
  return { current, previous };
}

/**
 * A PM's stars in the current sprint and the one before it, each oldest first; anything older
 * stays in the database and off the sky. With no sprint windows from its tracker, the newest two
 * sprints the stars name stand in.
 */
export function sprintsFor(
  stars: Star[],
  pmId: string,
  sky?: SprintSky,
  now: number = Date.now(),
): { current: Star[]; previous: Star[] } {
  const mine = stars.filter((s) => s.pmId === pmId).sort((a, b) => a.at - b.at);
  if (!sky?.current && !sky?.previous) return newestTwo(mine, now);
  const inSprint = (w: SprintWindow | null) => (w ? mine.filter((s) => s.sprint === w.path) : []);
  return { current: inSprint(sky.current), previous: inSprint(sky.previous) };
}

/** What a star's spot is drawn from: its PR number, or its story's when it has none. */
const spotKey = (s: Star) => (s.pr === null ? s.storyId : `pr-${s.pr}`);

/**
 * Every PM's stars laid in the band, PMs in home-row order and those with nothing left out. The
 * single latest lit star across the sky is the newest.
 */
export function placeGalaxy(
  stars: Star[],
  pmIds: string[],
  w: number,
  h: number,
  keep: KeepOut,
  skies: Record<string, SprintSky> = {},
  now: number = Date.now(),
): PmGalaxy[] {
  const place = (s: Star): SkyStar => ({
    ...s,
    ...galaxySpot(spotKey(s), w, h, keep),
    newest: false,
  });
  const out = pmIds
    .map((pmId) => {
      const { current, previous } = sprintsFor(stars, pmId, skies[pmId], now);
      return { pmId, lit: current.map(place), faded: previous.map(place) };
    })
    .filter((p) => p.lit.length || p.faded.length);
  const newest = out
    .flatMap((p) => p.lit)
    .reduce<SkyStar | null>((a, s) => (!a || s.at > a.at ? s : a), null);
  if (newest) newest.newest = true;
  return out;
}

/**
 * The stars that launch in: new since the sky was last looked at, and merged just now. The first
 * look launches nothing, and neither does a merge Orbit only learns about later.
 */
export function arrivals(known: Set<string> | null, stars: Star[], now: number): Set<string> {
  if (!known) return new Set();
  return new Set(
    stars.filter((s) => !known.has(s.id) && now - s.at < LAUNCH_FRESH_MS).map((s) => s.id),
  );
}
