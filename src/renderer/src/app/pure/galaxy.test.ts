import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandDust,
  bandPoint,
  bandWidth,
  galaxySpot,
  stageKeepOut,
  starLook,
  starSize,
  type KeepOut,
} from './galaxy.ts';

const W = 1600;
const H = 1000;
const none: KeepOut = { circles: [], rects: [] };

/** How far a point is from the band's spine, by sampling the spine finely. */
function offSpine(x: number, y: number, w = W, h = H): number {
  let best = Infinity;
  for (let i = 0; i <= 1000; i++) {
    const p = bandPoint(i / 1000, w, h);
    best = Math.min(best, Math.hypot(p.x - x, p.y - y));
  }
  return best;
}

test('the band runs corner to corner, top-left to bottom-right, with a unit normal across it', () => {
  const start = bandPoint(0, W, H);
  const end = bandPoint(1, W, H);
  assert.ok(start.x < 0 && start.y < H * 0.1, `starts off the top-left: ${start.x},${start.y}`);
  assert.ok(end.x > W && end.y > H * 0.9, `ends off the bottom-right: ${end.x},${end.y}`);
  for (const t of [0, 0.25, 0.5, 0.9]) {
    const p = bandPoint(t, W, H);
    const q = bandPoint(t + 0.001, W, H);
    assert.ok(Math.abs(Math.hypot(p.nx, p.ny) - 1) < 1e-9, 'unit normal');
    const along = (q.x - p.x) * p.nx + (q.y - p.y) * p.ny;
    assert.ok(Math.abs(along) < 1e-3, `normal is across the band at ${t}`);
  }
  assert.equal(bandWidth(W, H), 95);
  assert.equal(bandWidth(800, 1200), 76, 'from the shorter side');
});

test('stars are full size up to 8 and shrink with the square root of the count, never below dust', () => {
  assert.equal(starSize(0), 4.6);
  assert.equal(starSize(1), 4.6);
  assert.equal(starSize(8), 4.6);
  assert.equal(starSize(32), 2.3);
  assert.equal(starSize(120), 1.3);
  assert.equal(starSize(500), 1.3);
  for (let n = 1; n < 200; n++) assert.ok(starSize(n + 1) <= starSize(n), `never grows: ${n}`);
});

test('a PR keeps its spot in the band, and two PRs get two spots', () => {
  const a = galaxySpot('pr-7162', W, H, none);
  assert.deepEqual(galaxySpot('pr-7162', W, H, none), a);
  assert.notDeepEqual(galaxySpot('pr-7144', W, H, none), a);
  for (let n = 2000; n < 2200; n++) {
    const p = galaxySpot(`pr-${n}`, W, H, none);
    assert.ok(offSpine(p.x, p.y) <= bandWidth(W, H) * 2.2, `inside the band: pr-${n}`);
    assert.ok(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H, `on the stage: pr-${n}`);
  }
});

test('a spot that would land on a core, the top bar, or the legend is rerolled clear, the same way every time', () => {
  const keep = stageKeepOut(W, H, [
    { x: 720, y: 549, r: 44 },
    { x: 917, y: 564, r: 44 },
  ]);
  const clear = (p: { x: number; y: number }) =>
    keep.circles.every((c) => Math.hypot(p.x - c.x, p.y - c.y) > c.r) &&
    keep.rects.every((r) => p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h);
  let moved = 0;
  for (let n = 0; n < 400; n++) {
    const key = `pr-${n}`;
    const p = galaxySpot(key, W, H, keep);
    assert.ok(clear(p), `clear of every keep-out: ${key} at ${p.x},${p.y}`);
    assert.deepEqual(galaxySpot(key, W, H, keep), p);
    if (!clear(galaxySpot(key, W, H, none))) moved++;
  }
  assert.ok(moved > 0, 'some spots needed the reroll');
  assert.ok(
    keep.rects.some((r) => r.y === 0 && r.w === W),
    'the top bar is kept clear',
  );
  assert.ok(
    keep.rects.some((r) => r.x + r.w === W && r.y + r.h === H && r.h >= 210),
    'the legend corner is kept clear, with the memory panel stacked on it',
  );
  assert.equal(keep.circles[0].r, 44 + 48, 'a core keeps its rings and a full-size glow clear too');
  assert.ok(
    keep.rects.some((r) => r.x === 720 - 150 && r.y === 549 + 44 + 34 && r.w === 300 && r.h === 40),
    'and the caption under it',
  );
});

test('the dust is the same every time for a stage, and hugs the spine', () => {
  const dust = bandDust(W, H);
  assert.deepEqual(bandDust(W, H), dust);
  assert.ok(
    dust.specks.length > 3000 && dust.specks.length < 10_000,
    `specks: ${dust.specks.length}`,
  );
  assert.ok(dust.glows.length > 300, `glows: ${dust.glows.length}`);
  assert.ok(dust.wisps.length > 100, `wisps: ${dust.wisps.length}`);
  const w = bandWidth(W, H);
  for (const s of dust.specks.filter((_, i) => i % 25 === 0)) {
    assert.ok(offSpine(s.x, s.y) < w * 5.5, `speck near the spine: ${s.x},${s.y}`);
    assert.ok(s.a > 0 && s.a <= 1, 'a speck has a strength');
  }
  const wide = bandDust(3200, H);
  assert.ok(
    Math.max(...wide.specks.map((s) => s.x)) > W * 1.5,
    'a wider stage spreads the band wider',
  );
});

test('a full-size star carries its glow, well, and flare; dust carries almost none and no flare', () => {
  assert.deepEqual(starLook(8), { size: 4.6, faint: 2.76, presence: 1, flare: 12, hit: 11 });
  assert.deepEqual(starLook(120), { size: 1.3, faint: 0.9, presence: 0.11, flare: 0, hit: 7 });
  const mid = starLook(30);
  assert.ok(mid.presence > 0.2 && mid.presence < 0.6, `half size, part glow: ${mid.presence}`);
  assert.equal(mid.flare, 0, 'no flare once a star is under 3.2px');
});
