import { hashName } from './layout.ts';
import { mulberry32 } from './stars.ts';

/** A globe is drawn on a sphere of this radius and scaled to the core's size. */
export const GLOBE_UNIT = 100;
/** The surface repeats every 2.4 radii as the globe turns; one loop spans -120 to 120. */
export const SURFACE_LOOP = 240;
const HALF_LOOP = SURFACE_LOOP / 2;
/** Room kept clear at each end of a loop, so a coastline or a soft cloud never crosses the seam. */
const SEAM_MARGIN = 8;

export type WorldKind =
  'terran' | 'desert' | 'ice' | 'ocean' | 'banded' | 'lava' | 'jungle' | 'rust' | 'violet';

export interface WorldPalette {
  /** What covers the globe between the landmasses: sea, sand, ice, or a gas giant's base colour. */
  sea: string;
  /** The lighter rim around each landmass: shallow water, dunes, or a storm's halo. */
  shelf: string;
  land: string;
  high: string;
  cap: string | null;
}

/** A planet's look, all in globe units, picked from a lane's id so a lane always looks the same. */
export interface World {
  kind: WorldKind;
  /** Seed for the surface's noise texture. */
  seed: number;
  palette: WorldPalette;
  land: string[];
  high: string[];
  /** A gas giant's stripes, top to bottom, each running edge to edge across one loop. */
  bands: Array<{ d: string; color: string }>;
  clouds: string[];
  caps: string[];
}

const PALETTES: Record<WorldKind, WorldPalette> = {
  terran: { sea: '#2b5f8a', shelf: '#4d8db0', land: '#5e8a4a', high: '#a08d5c', cap: '#e8eff3' },
  desert: { sea: '#c08a5e', shelf: '#d9ab7e', land: '#9a6040', high: '#74462f', cap: '#efe4d6' },
  ice: { sea: '#6f9cb5', shelf: '#9cc3d4', land: '#e3eef3', high: '#ffffff', cap: '#ffffff' },
  ocean: { sea: '#1f6873', shelf: '#3c9c96', land: '#6f9a4e', high: '#c9b97c', cap: null },
  banded: { sea: '#c9a37b', shelf: '#ead5b4', land: '#b5603f', high: '#d98a60', cap: null },
  lava: { sea: '#3b2b28', shelf: '#ff7a2e', land: '#e5481e', high: '#ffb43a', cap: null },
  jungle: { sea: '#1a5a48', shelf: '#3a8c6a', land: '#3c9a3a', high: '#86c24a', cap: null },
  rust: { sea: '#b04a2a', shelf: '#c8673f', land: '#6b2a1b', high: '#d4a578', cap: '#f4efe9' },
  violet: { sea: '#7d6fbf', shelf: '#d6cdf6', land: '#3e3484', high: '#8f82d6', cap: null },
};
const BAND_COLORS = {
  banded: ['#9a6a48', '#e3cba6', '#b07f58', '#d8b48c', '#8c5d41', '#efdcbc'],
  violet: ['#6a5bb0', '#c7bcef', '#8577c9', '#b3a6e6', '#5a4c9e', '#ddd4f7'],
};
const KINDS: WorldKind[] = [
  'terran',
  'desert',
  'ice',
  'ocean',
  'banded',
  'lava',
  'jungle',
  'rust',
  'violet',
];

const TINTS: Record<WorldKind, { dark: string; light: string }> = {
  terran: { dark: '#7cc4ff', light: '#1f6fb2' },
  desert: { dark: '#ffb86b', light: '#b35f0e' },
  ice: { dark: '#8fe3ff', light: '#1b84a8' },
  ocean: { dark: '#4fe0c8', light: '#0d8573' },
  banded: { dark: '#ff8fc8', light: '#b3246f' },
  lava: { dark: '#ffd84a', light: '#9e7700' },
  jungle: { dark: '#7fe36a', light: '#2f8a1f' },
  rust: { dark: '#ff6464', light: '#b3202a' },
  violet: { dark: '#ab8cff', light: '#6b46c8' },
};

/** The colour a world's constellation is drawn in: bright on the dark stage, deeper on the light one. */
export function worldTint(kind: WorldKind, dark: boolean): string {
  return dark ? TINTS[kind].dark : TINTS[kind].light;
}

/**
 * The world each home lane is drawn as, walking them in order: a lane takes its hashed kind, or
 * steps on to the next kind no earlier lane has. Once every kind is taken, repeats are allowed.
 */
export function worldKinds(ids: string[]): Map<string, WorldKind> {
  const out = new Map<string, WorldKind>();
  const taken = new Set<WorldKind>();
  for (const id of ids) {
    const start = hashName(id) % KINDS.length;
    const order = KINDS.map((_, i) => KINDS[(start + i) % KINDS.length]);
    const kind = order.find((k) => !taken.has(k)) ?? order[0];
    taken.add(kind);
    out.set(id, kind);
  }
  return out;
}

type Rand = () => number;
type Point = [number, number];

const between = (rand: Rand, lo: number, hi: number) => lo + rand() * (hi - lo);
const round = (n: number) => Math.round(n * 10) / 10;

/** A smooth closed curve through the points, as Catmull-Rom segments written as cubic Béziers. */
export function smoothClosed(pts: Point[]): string {
  const at = (i: number) => pts[(i + pts.length) % pts.length];
  const parts = [`M ${round(pts[0][0])} ${round(pts[0][1])}`];
  for (let i = 0; i < pts.length; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    parts.push(
      `C ${c1.map(round).join(' ')} ${c2.map(round).join(' ')} ${round(p2[0])} ${round(p2[1])}`,
    );
  }
  return `${parts.join(' ')} Z`;
}

/** A lumpy oval: an ellipse whose edge wanders in and out by up to `wobble` of its size. */
function blob(rand: Rand, cx: number, cy: number, rx: number, ry: number, wobble = 0.35): string {
  const n = 9;
  const pts = Array.from({ length: n }, (_, i): Point => {
    const a = (i / n) * Math.PI * 2;
    const k = 1 - wobble / 2 + rand() * wobble;
    return [cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k];
  });
  return smoothClosed(pts);
}

/**
 * Landmasses spread across one loop of the surface: each is a main lobe with a couple of smaller
 * ones leaning off it, and a highland inside. Every one stays clear of the loop's seam.
 */
function landmasses(rand: Rand, count: number, size: [number, number], lobes: number) {
  const land: string[] = [];
  const high: string[] = [];
  const slot = SURFACE_LOOP / count;
  for (let k = 0; k < count; k++) {
    const rx = between(rand, size[0], size[1]);
    const ry = rx * between(rand, 0.6, 0.95);
    const reach = rx * (lobes ? 1.5 : 1.2) + SEAM_MARGIN;
    const centre = -HALF_LOOP + slot * (k + 0.5) + between(rand, -0.2, 0.2) * slot;
    const cx = Math.max(-HALF_LOOP + reach, Math.min(HALF_LOOP - reach, centre));
    const cy = between(rand, -55, 55);
    land.push(blob(rand, cx, cy, rx, ry));
    for (let j = 0; j < lobes; j++) {
      const a = between(rand, 0, Math.PI * 2);
      const s = between(rand, 0.45, 0.7);
      land.push(
        blob(rand, cx + Math.cos(a) * rx * 0.6, cy + Math.sin(a) * ry * 0.55, rx * s, ry * s),
      );
    }
    high.push(blob(rand, cx + rx * 0.1, cy - ry * 0.1, rx * 0.45, ry * 0.4, 0.5));
  }
  return { land, high };
}

/** Long thin wisps, a little faster than the ground, each kept clear of the loop's seam. */
function cloudBank(rand: Rand, count: number): string[] {
  const clouds: string[] = [];
  const slot = SURFACE_LOOP / Math.max(1, count);
  for (let k = 0; k < count; k++) {
    const rx = between(rand, 16, 30);
    const ry = between(rand, 3.5, 7);
    const reach = rx * 1.4 + SEAM_MARGIN;
    const centre = -HALF_LOOP + slot * (k + 0.5) + between(rand, -0.25, 0.25) * slot;
    const cx = Math.max(-HALF_LOOP + reach, Math.min(HALF_LOOP - reach, centre));
    const cy = between(rand, -80, 80);
    clouds.push(blob(rand, cx, cy, rx, ry, 0.5));
    clouds.push(blob(rand, cx + rx * 0.45, cy + ry * 0.9, rx * 0.55, ry * 0.8, 0.5));
  }
  return clouds;
}

/**
 * The wavy top edge of a stripe, filled down to the bottom of the globe. The wave repeats every
 * loop, and each end runs a unit past the seam so neighbouring loops overlap instead of leaving a hairline.
 */
function bandPath(y: number, amp: number, waves: number, phase: number): string {
  const xs = [-HALF_LOOP - 1];
  for (let x = -HALF_LOOP; x <= HALF_LOOP; x += 10) xs.push(x);
  xs.push(HALF_LOOP + 1);
  const pts = xs.map((x) => {
    const t = ((x + HALF_LOOP) / SURFACE_LOOP) * Math.PI * 2 * waves + phase;
    return `${x} ${round(y + amp * Math.sin(t))}`;
  });
  const end = HALF_LOOP + 1;
  return `M ${pts.join(' L ')} L ${end} ${GLOBE_UNIT} L ${-end} ${GLOBE_UNIT} Z`;
}

function bands(rand: Rand, colors: string[]): Array<{ d: string; color: string }> {
  const out: Array<{ d: string; color: string }> = [];
  let y = -GLOBE_UNIT + between(rand, 10, 22);
  for (let k = 0; y < GLOBE_UNIT - 12; k++) {
    const waves = 1 + Math.floor(rand() * 3);
    out.push({
      d: bandPath(y, between(rand, 1.5, 4.5), waves, rand() * Math.PI * 2),
      color: colors[k % colors.length],
    });
    y += between(rand, 14, 30);
  }
  return out;
}

function polarCaps(rand: Rand, size: number): string[] {
  return [
    blob(rand, 0, -GLOBE_UNIT - 4, 62 * size, 26 * size, 0.3),
    blob(rand, 0, GLOBE_UNIT + 6, 52 * size, 22 * size, 0.3),
  ];
}

/** A gas giant: stripes in the given colours, with one great storm riding them. */
function giant(rand: Rand, colors: string[]) {
  const cx = between(rand, -40, 40);
  const cy = between(rand, 20, 45);
  return {
    land: [blob(rand, cx, cy, 20, 11, 0.15)],
    high: [blob(rand, cx, cy, 10, 5, 0.2)],
    bands: bands(rand, colors),
  };
}

/**
 * The world a lane is drawn as, of the given kind or else one hashed from its id. The same id and
 * kind always give the same world.
 */
export function worldFor(id: string, kind = KINDS[hashName(id) % KINDS.length]): World {
  const hash = hashName(id);
  const rand = mulberry32(hash);
  const base = { kind, seed: hash % 997, palette: PALETTES[kind], bands: [], clouds: [], caps: [] };
  switch (kind) {
    case 'terran':
      return {
        ...base,
        ...landmasses(rand, 3, [18, 26], 2),
        clouds: cloudBank(rand, 4),
        caps: polarCaps(rand, 1),
      };
    case 'desert':
      return {
        ...base,
        ...landmasses(rand, 4, [10, 17], 1),
        clouds: cloudBank(rand, 1),
        caps: polarCaps(rand, 0.6),
      };
    case 'ice':
      return {
        ...base,
        ...landmasses(rand, 3, [16, 24], 2),
        clouds: cloudBank(rand, 2),
        caps: polarCaps(rand, 1.3),
      };
    case 'ocean':
      return { ...base, ...landmasses(rand, 6, [6, 11], 1), clouds: cloudBank(rand, 6) };
    case 'banded':
    case 'violet':
      return { ...base, ...giant(rand, BAND_COLORS[kind]) };
    case 'lava':
      return { ...base, ...landmasses(rand, 5, [9, 15], 1) };
    case 'jungle':
      return { ...base, ...landmasses(rand, 3, [20, 28], 2), clouds: cloudBank(rand, 8) };
    case 'rust':
      return { ...base, ...landmasses(rand, 3, [13, 21], 1), caps: polarCaps(rand, 0.5) };
  }
}

export interface MoonFace {
  base: string;
  dark: string;
  light: string;
  /** Seed for the regolith's noise texture. */
  seed: number;
  maria: string[];
  craters: Array<{ x: number; y: number; r: number }>;
}

const MOON_PALETTES: Array<Pick<MoonFace, 'base' | 'dark' | 'light'>> = [
  { base: '#a3a3a6', dark: '#66666b', light: '#dcdce0' },
  { base: '#b9a789', dark: '#7c6c53', light: '#e4d8c0' },
  { base: '#93a0ad', dark: '#5b6774', light: '#cfd8e0' },
  { base: '#ad8a76', dark: '#74574a', light: '#dcc4b4' },
];

/** A moon's face: grey or tan rock, a couple of dark plains, and craters that never spill off the edge. */
export function moonFace(id: string, radius: number): MoonFace {
  const hash = hashName(id);
  const rand = mulberry32(hash ^ 0x5bd1e995);
  const maria = Array.from({ length: 2 }, () => {
    const a = between(rand, 0, Math.PI * 2);
    const d = between(rand, 0.1, 0.45) * radius;
    return blob(
      rand,
      Math.cos(a) * d,
      Math.sin(a) * d,
      between(rand, 0.25, 0.42) * radius,
      between(rand, 0.2, 0.32) * radius,
      0.5,
    );
  });
  const craters: MoonFace['craters'] = [];
  for (let tries = 0; craters.length < 5 && tries < 60; tries++) {
    const r = between(rand, 0.12, 0.28) * radius;
    const a = between(rand, 0, Math.PI * 2);
    const d = rand() * (radius * 0.9 - r);
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    if (craters.some((c) => Math.hypot(c.x - x, c.y - y) < c.r + r)) continue;
    craters.push({ x: round(x), y: round(y), r: round(r) });
  }
  return { ...MOON_PALETTES[hash % MOON_PALETTES.length], seed: hash % 991, maria, craters };
}
