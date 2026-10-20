export interface Star {
  x: number;
  y: number;
  r: number;
  opacity: number;
  /** 0 is far away and leans with the galaxy, 1 is up close and leans a little more. */
  layer: 0 | 1;
}

export type SkyDepth = 'far' | 'near';

/** How far each depth of the sky leans at full tilt, in px: the galaxy, its PR stars, and the far stars together. */
const LEAN: Record<SkyDepth, { x: number; y: number }> = {
  far: { x: 10, y: 6 },
  near: { x: 16, y: 10 },
};

/** Where a depth of the sky sits for a pointer at `tilt` (-1..1 from the middle): leaning the other way. */
export function leanFor(tilt: { x: number; y: number }, depth: SkyDepth): { x: number; y: number } {
  const lean = LEAN[depth];
  return { x: -tilt.x * lean.x || 0, y: -tilt.y * lean.y || 0 };
}

/** Small deterministic generator so the sky looks the same on every launch and in every screenshot. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed sky for a stage of the given size: two layers of stars, a few bright ones at full strength. */
export function starfield(width: number, height: number, count = 220, seed = 7): Star[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => {
    const layer: 0 | 1 = i % 3 === 0 ? 1 : 0;
    const bright = rand() > 0.85;
    return {
      x: Math.round(rand() * width),
      y: Math.round(rand() * height),
      r: layer ? (bright ? 2 : 1.3) : bright ? 1.3 : 0.9,
      opacity: Math.min(1, Math.round((layer ? 0.65 : 0.4) * (bright ? 1.6 : 1) * 100) / 100),
      layer,
    };
  });
}
