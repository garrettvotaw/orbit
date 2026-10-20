import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBE_UNIT,
  moonFace,
  SURFACE_LOOP,
  worldFor,
  worldKinds,
  worldTint,
  type WorldKind,
} from './worlds.ts';

/** Every x, y pair a path visits, control points included. */
function points(d: string): Array<[number, number]> {
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

const IDS = ['shop', 'cart', 'prs', 'ask', 'review-7127', 'store', 'story-shop-100203'];
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
const LANES = Array.from({ length: 200 }, (_, i) => `lane-${i}`);

test('a lane always gets the same world, and two PMs get different ones', () => {
  assert.deepEqual(worldFor('shop'), worldFor('shop'));
  assert.notDeepEqual(worldFor('shop'), worldFor('cart'));
  const kinds = new Set(IDS.map((id) => worldFor(id).kind));
  assert.ok(kinds.size >= 3, `only ${[...kinds].join(', ')}`);
});

test('land and clouds stay inside one loop of the surface, so the turn never pops at the seam', () => {
  const half = SURFACE_LOOP / 2;
  for (const id of IDS)
    for (const kind of KINDS) {
      const w = worldFor(id, kind);
      for (const d of [...w.land, ...w.high, ...w.clouds])
        for (const [x] of points(d))
          assert.ok(Math.abs(x) < half, `${id} as ${kind}: x ${x} crosses the seam`);
    }
});

test("a gas giant's stripes meet themselves across the seam", () => {
  for (const kind of ['banded', 'violet'] as const) {
    assert.ok(
      LANES.some((n) => worldFor(n).kind === kind),
      `some id draws ${kind}`,
    );
    const w = worldFor('shop', kind);
    assert.ok(w.bands.length >= 4);
    assert.equal(w.land.length, 1, 'one great storm');
    for (const b of w.bands) {
      const edge = points(b.d).filter(([, y]) => y !== GLOBE_UNIT);
      const left = edge.find(([x]) => x === -SURFACE_LOOP / 2);
      const right = edge.find(([x]) => x === SURFACE_LOOP / 2);
      assert.ok(left && right);
      assert.ok(Math.abs(left[1] - right[1]) < 0.11, `${left[1]} vs ${right[1]}`);
    }
  }
});

test('a passed kind overrides the hashed one, and the same id and kind give the same world', () => {
  for (const kind of KINDS) {
    assert.equal(worldFor('shop', kind).kind, kind);
    assert.deepEqual(worldFor('shop', kind), worldFor('shop', kind));
  }
  assert.deepEqual(worldFor('shop', worldFor('shop').kind), worldFor('shop'));
  assert.notDeepEqual(worldFor('shop', 'lava'), worldFor('cart', 'lava'));
});

test('every kind turns up somewhere, and each of the new ones has its own look', () => {
  assert.deepEqual(new Set(LANES.map((n) => worldFor(n).kind)), new Set(KINDS));
  const look = (kind: WorldKind) => worldFor('shop', kind);
  assert.equal(new Set(KINDS.map((k) => look(k).palette.sea)).size, KINDS.length);
  assert.equal(look('lava').palette.cap, null);
  assert.ok(look('lava').clouds.length <= 2, 'lava is nearly cloudless');
  assert.equal(look('jungle').palette.cap, null);
  for (const k of KINDS)
    if (k !== 'jungle') assert.ok(look('jungle').clouds.length > look(k).clouds.length, k);
  assert.ok(look('rust').palette.cap && look('rust').caps.length === 2, 'a Mars has polar caps');
  const violet = new Set(look('violet').bands.map((b) => b.color));
  assert.ok(
    look('banded').bands.every((b) => !violet.has(b.color)),
    'violet has its own stripes',
  );
});

test('home lanes take different worlds until all nine are taken', () => {
  assert.equal(worldKinds([]).size, 0);
  assert.equal(worldKinds(['shop']).get('shop'), worldFor('shop').kind);
  const nine = LANES.slice(0, 9);
  assert.equal(new Set(worldKinds(nine).values()).size, 9);
  assert.deepEqual(worldKinds(nine), worldKinds(nine));
  const tenth = LANES[9];
  assert.equal(worldKinds([...nine, tenth]).get(tenth), worldFor(tenth).kind);
});

test('a lane whose world is taken steps forward to the next free kind, wrapping', () => {
  const first = LANES[0];
  const kind = worldFor(first).kind;
  const twin = LANES.slice(1).find((n) => worldFor(n).kind === kind);
  assert.ok(twin, 'two ids hash to the same kind');
  const next = KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length];
  const kinds = worldKinds([first, twin]);
  assert.equal(kinds.get(first), kind);
  assert.equal(kinds.get(twin), next);
  const last = LANES.find((n) => worldFor(n).kind === 'violet');
  const other = LANES.find((n) => n !== last && worldFor(n).kind === 'violet');
  assert.ok(last && other);
  assert.equal(worldKinds([last, other]).get(other), 'terran');
});

/** How far apart the brightest and dimmest channels are, 0 to 255. */
function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
}
const luma = (hex: string) =>
  [1, 3, 5].reduce(
    (sum, i, k) => sum + parseInt(hex.slice(i, i + 2), 16) * [0.3, 0.59, 0.11][k],
    0,
  );

test('each world tints its constellation in a colour of its own, darker on the light stage', () => {
  assert.equal(worldTint('terran', true), '#7cc4ff');
  assert.equal(worldTint('terran', false), '#1f6fb2');
  assert.equal(worldTint('desert', true), '#ffb86b');
  assert.equal(worldTint('desert', false), '#b35f0e');
  assert.equal(worldTint('ice', true), '#8fe3ff');
  assert.equal(worldTint('ice', false), '#1b84a8');
  assert.equal(worldTint('ocean', true), '#4fe0c8');
  assert.equal(worldTint('ocean', false), '#0d8573');
  // Rose, not coral: the gas giant often sits beside a desert world, and two oranges read as one PM.
  assert.equal(worldTint('banded', true), '#ff8fc8');
  assert.equal(worldTint('banded', false), '#b3246f');
  for (const dark of [true, false])
    assert.equal(new Set(KINDS.map((k) => worldTint(k, dark))).size, KINDS.length);
  for (const k of KINDS) {
    const [night, day] = [worldTint(k, true), worldTint(k, false)];
    assert.match(night, /^#[0-9a-f]{6}$/);
    assert.match(day, /^#[0-9a-f]{6}$/);
    assert.ok(chroma(night) >= 100 && chroma(day) >= 100, `${k} reads as a white star`);
    assert.ok(luma(day) < luma(night), `${k} is not darker on the light stage`);
  }
});

test('craters sit wholly on the moon and never overlap', () => {
  for (const id of IDS) {
    const face = moonFace(id, 20);
    assert.ok(face.craters.length >= 3);
    for (const c of face.craters)
      assert.ok(Math.hypot(c.x, c.y) + c.r <= 20, `${id}: crater spills`);
    for (const a of face.craters)
      for (const b of face.craters)
        if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 0.2);
  }
  assert.deepEqual(moonFace('story-shop-100203', 20), moonFace('story-shop-100203', 20));
});
