import { hashName } from './layout.ts';
import { mulberry32 } from './stars.ts';

/** A point on the band's spine and the unit normal across it. */
export interface BandPoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/** Circles and boxes a PR star must not land in. */
export interface KeepOut {
  circles: Array<{ x: number; y: number; r: number }>;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface Speck {
  x: number;
  y: number;
  /** Strength, 0..1. */
  a: number;
  size: number;
}

export interface Glow {
  x: number;
  y: number;
  r: number;
  /** An `r,g,b` triple, so the painter can fade it out. */
  rgb: string;
  a: number;
}

export interface Wisp {
  x: number;
  y: number;
  r: number;
  a: number;
}

/** The band's dust: soft glow, a dense scatter of specks, and dark wisps that break up its middle. */
export interface Dust {
  glows: Glow[];
  specks: Speck[];
  wisps: Wisp[];
}

export const STAR_MAX = 4.6;
export const STAR_MIN = 1.3;
/** The cross-flare only shows on stars bigger than this. */
export const FLARE_MIN = 3.2;
/** Up to this many lit stars, every one is full size. */
const FULL_SIZE_UP_TO = 8;
/** How wide the band is across, as a share of the stage's shorter side. */
const BAND_WIDTH = 0.095;
/** How far past its radius a core keeps stars off: its rings, halo, and status arc, plus a full-size star's glow. */
const CORE_CLEARANCE = 48;
/** The cost-and-age caption under a core (it sits 40-51 px past the radius), padded for a full-size star's glow. */
const CAPTION = { top: 34, w: 300, h: 40 };
/** The header and the buttons along the top. */
const TOP_BAR = 110;
/** The legend in the bottom-right corner, with the memory panel stacked on it. */
const LEGEND = { w: 340, h: 210 };
/** Stars stay this far in from the stage's edges. */
const EDGE = 12;

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * The Milky Way's spine at t in [0, 1]: corner to corner, top-left to bottom-right, bowed a little
 * upward, running just past both corners so its ends never show.
 */
export function bandPoint(t: number, w: number, h: number): BandPoint {
  const bow = h * 0.05;
  const x = -0.05 * w + t * 1.1 * w;
  const y = 0.02 * h + t * 0.92 * h - Math.sin(t * Math.PI) * bow;
  const dx = 1.1 * w;
  const dy = 0.92 * h - Math.PI * Math.cos(t * Math.PI) * bow;
  const len = Math.hypot(dx, dy);
  return { x, y, nx: -dy / len, ny: dx / len };
}

/** How far the band's light spreads across its spine: one standard deviation, in pixels. */
export function bandWidth(w: number, h: number): number {
  return Math.round(Math.min(w, h) * BAND_WIDTH * 10) / 10;
}

/** How big this sprint's stars are: full size up to 8 lit, then shrinking with the square root of the count. */
export function starSize(lit: number): number {
  const size = STAR_MAX * Math.sqrt(FULL_SIZE_UP_TO / Math.max(FULL_SIZE_UP_TO, lit));
  return Math.round(Math.max(STAR_MIN, size) * 100) / 100;
}

/** How this sprint's stars are drawn at their size: what's left of the glow and flare, and how big a target to hover. */
export interface StarLook {
  size: number;
  /** Last sprint's stars: smaller, and never under a pixel. */
  faint: number;
  /** How much of the glow and dark well a star keeps, 1 at full size down to almost none as dust. */
  presence: number;
  /** Half the cross-flare's length, or 0 when a star is too small for one. */
  flare: number;
  /** The hover target's radius, so dust is still easy to point at. */
  hit: number;
}

const FAINT_MIN = 0.9;
const HIT_MIN = 7;

export function starLook(lit: number): StarLook {
  const size = starSize(lit);
  const presence = Math.min(1, Math.max(0, (size - FAINT_MIN) / (STAR_MAX - FAINT_MIN)));
  return {
    size,
    faint: Math.round(Math.max(FAINT_MIN, size * 0.6) * 100) / 100,
    presence: Math.round(presence * 100) / 100,
    flare: size > FLARE_MIN ? round(size * 2.6) : 0,
    hit: Math.max(HIT_MIN, round(size * 2.4)),
  };
}

/** Where stars may not land on a stage: each core with its rings, the top bar, and the legend. */
export function stageKeepOut(
  w: number,
  h: number,
  cores: Array<{ x: number; y: number; r: number }>,
): KeepOut {
  return {
    circles: cores.map((c) => ({ x: c.x, y: c.y, r: c.r + CORE_CLEARANCE })),
    rects: [
      { x: 0, y: 0, w, h: TOP_BAR },
      { x: w - LEGEND.w, y: h - LEGEND.h, w: LEGEND.w, h: LEGEND.h },
      ...cores.map((c) => ({
        x: c.x - CAPTION.w / 2,
        y: c.y + c.r + CAPTION.top,
        w: CAPTION.w,
        h: CAPTION.h,
      })),
    ],
  };
}

/** A standard normal draw from a seeded generator. */
function gauss(rand: () => number): number {
  const u = rand() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function clearOf(p: { x: number; y: number }, w: number, h: number, keep: KeepOut): boolean {
  if (p.x < EDGE || p.x > w - EDGE || p.y < EDGE || p.y > h - EDGE) return false;
  if (keep.circles.some((c) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r)) return false;
  return !keep.rects.some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
}

/**
 * Where a PR's star sits: a spot along the band and a little way across it, drawn from its key so
 * it never moves. A spot off the stage or in a keep-out is drawn again from the same sequence, so
 * the reroll lands in the same place every time too.
 */
export function galaxySpot(
  key: string,
  w: number,
  h: number,
  keep: KeepOut,
): { x: number; y: number } {
  const rand = mulberry32(hashName(key));
  const across = bandWidth(w, h);
  let spot = { x: w / 2, y: h / 2 };
  for (let i = 0; i < 40; i++) {
    const p = bandPoint(rand(), w, h);
    const o = Math.max(-2, Math.min(2, gauss(rand))) * across * 0.55;
    spot = { x: round(p.x + p.nx * o), y: round(p.y + p.ny * o) };
    if (clearOf(spot, w, h, keep)) return spot;
  }
  return spot;
}

/** How bright the band is along its length: brightest mid-sky, with a slow ripple so it isn't uniform. */
function brightness(t: number): number {
  return 0.36 + 0.28 * Math.sin(t * Math.PI) + 0.08 * Math.sin(t * 23 + 2);
}

const SPINE_STEPS = 160;
const CLUMPS = 90;
const SPECK_TRIES = 10_000;
const WISP_STEPS = 600;

/** The glow: a cool wide haze and a warmer core along the spine, plus soft clumps scattered across it. */
function glows(w: number, h: number, rand: () => number): Glow[] {
  const across = bandWidth(w, h);
  const out: Glow[] = [];
  for (let i = 0; i <= SPINE_STEPS; i++) {
    const t = i / SPINE_STEPS;
    const p = bandPoint(t, w, h);
    const b = brightness(t);
    out.push({ x: p.x, y: p.y, r: across * 2.6, rgb: '140,165,215', a: 0.024 * b });
    out.push({
      x: p.x + p.nx * across * 0.25,
      y: p.y + p.ny * across * 0.25,
      r: across * 1.25,
      rgb: '235,215,185',
      a: 0.03 * b,
    });
  }
  for (let i = 0; i < CLUMPS; i++) {
    const t = rand();
    const p = bandPoint(t, w, h);
    const o = gauss(rand) * across * 0.7;
    out.push({
      x: p.x + p.nx * o,
      y: p.y + p.ny * o,
      r: across * (0.25 + rand() * 0.6),
      rgb: rand() < 0.5 ? '205,190,235' : '180,205,240',
      a: 0.035 * brightness(t),
    });
  }
  return out;
}

/** The specks: dense near the spine, thinning out across it, fewer where the band is dim. */
function specks(w: number, h: number, rand: () => number): Speck[] {
  const across = bandWidth(w, h);
  const out: Speck[] = [];
  for (let i = 0; i < SPECK_TRIES; i++) {
    const t = rand();
    if (rand() > brightness(t)) continue;
    const p = bandPoint(t, w, h);
    const o = gauss(rand) * across * (rand() < 0.8 ? 0.55 : 1.25);
    const a = (0.16 + rand() * 0.55) * Math.exp(-(o * o) / (2 * across * across));
    out.push({
      x: round(p.x + p.nx * o + gauss(rand) * 4),
      y: round(p.y + p.ny * o + gauss(rand) * 4),
      a: Math.round(a * 1000) / 1000 || 0.001,
      size: rand() < 0.05 ? 1.5 : 0.85,
    });
  }
  return out;
}

/** The dark lane: patchy wisps that wander either side of the spine and break off in places. */
function wisps(w: number, h: number, rand: () => number, seed: number): Wisp[] {
  const across = bandWidth(w, h);
  const out: Wisp[] = [];
  for (let i = 0; i <= WISP_STEPS; i++) {
    const t = i / WISP_STEPS;
    if (rand() < 0.4 || Math.sin(t * 13 + seed) < -0.55) continue;
    const p = bandPoint(t, w, h);
    const o = across * 0.05 + Math.sin(t * 17 + seed) * across * 0.2 + gauss(rand) * across * 0.1;
    out.push({
      x: p.x + p.nx * o,
      y: p.y + p.ny * o,
      r: across * (0.1 + 0.22 * rand()),
      a: 0.2 * (0.35 + 0.65 * Math.abs(Math.sin(t * 9 + seed * 0.7))),
    });
  }
  return out;
}

/** Everything the band is painted from, the same for a stage every time. */
export function bandDust(w: number, h: number, seed = 11): Dust {
  const rand = mulberry32(seed);
  return {
    glows: glows(w, h, rand),
    specks: specks(w, h, rand),
    wisps: wisps(w, h, mulberry32(seed + 99), seed),
  };
}
