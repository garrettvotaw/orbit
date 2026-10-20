import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SprintSky, Star } from '../../../../shared/types.ts';
import { arrivals, placeGalaxy, sprintsFor } from './constellations.ts';
import { galaxySpot, type KeepOut } from './galaxy.ts';

const star = (storyId: string, sprint: string | null, at: number, pmId = 'shop'): Star => ({
  id: `story-${pmId}-${storyId}`,
  pmId,
  storyId,
  title: `Story ${storyId}`,
  pr: 1,
  prUrl: null,
  sprint,
  at,
});
const none: KeepOut = { circles: [], rects: [] };

test('sprintsFor lights the newest sprint, keeps the one before as plain stars, and drops the rest', () => {
  const stars = [
    star('1', 'Sprint 39', 1),
    star('2', 'Sprint 40', 5),
    star('3', 'Sprint 41', 9),
    star('4', 'Sprint 40', 6),
    star('5', 'Sprint 41', 12),
    star('6', 'Sprint 41', 3, 'cart'),
  ];
  const { current, previous } = sprintsFor(stars, 'shop');
  assert.deepEqual(
    current.map((s) => s.storyId),
    ['3', '5'],
  );
  assert.deepEqual(
    previous.map((s) => s.storyId),
    ['2', '4'],
  );
  assert.deepEqual(sprintsFor([], 'shop'), { current: [], previous: [] });
});

const sky: SprintSky = {
  current: {
    name: 'Sprint 14 (9.30 - 10.20)',
    path: 'Storefront\Sprint 14 (9.30 - 10.20)',
    start: 100,
    finish: 200,
  },
  previous: {
    name: 'Sprint 13 (9.9 - 9.29)',
    path: 'Storefront\Sprint 13 (9.9 - 9.29)',
    start: 0,
    finish: 100,
  },
};

test('with sprint windows, sprintsFor lights the current sprint and fades the previous by path, not by age', () => {
  const stars = [
    star('1', sky.previous!.path, 50),
    star('2', sky.current!.path, 120),
    star('3', 'Storefront\Sprint 9', 300),
    star('4', sky.current!.path, 110),
    star('5', sky.current!.path, 130, 'cart'),
  ];
  const { current, previous } = sprintsFor(stars, 'shop', sky);
  assert.deepEqual(
    current.map((s) => s.storyId),
    ['4', '2'],
  );
  assert.deepEqual(
    previous.map((s) => s.storyId),
    ['1'],
  );
});

test('a new sprint with nothing merged yet has an empty sky, with last sprint faded', () => {
  const next: SprintSky = {
    current: { ...sky.current!, path: 'Storefront\Sprint 15' },
    previous: sky.current,
  };
  const { current, previous } = sprintsFor([star('2', sky.current!.path, 120)], 'shop', next);
  assert.deepEqual(current, []);
  assert.deepEqual(
    previous.map((s) => s.storyId),
    ['2'],
  );
});

test('a star arrives with the launch only when it is new this session and merged just now', () => {
  const now = 1_000_000;
  const stars = [
    { ...star('1', 'S', now - 60_000) },
    { ...star('2', 'S', now - 60 * 60_000) },
    { ...star('3', 'S', now - 1000) },
  ];
  assert.deepEqual(
    [...arrivals(new Set(['story-shop-3']), stars, now)],
    ['story-shop-1'],
    'old merges and known stars stay put',
  );
  assert.deepEqual(
    [...arrivals(null, stars, now)],
    [],
    'the first look at the sky launches nothing',
  );
});

test('placeGalaxy lays every PM’s stars in the band, lit and faded, and marks the one newest across the sky', () => {
  const stars = [
    { ...star('1', 'S1', 1), pr: 2001 },
    { ...star('3', 'S2', 9), pr: 2003 },
    { ...star('5', 'S2', 12), pr: 2005 },
    { ...star('7', 'S2', 15, 'cart'), pr: 2007 },
    { ...star('8', 'S1', 2, 'cart'), pr: 2008 },
  ];
  const sky = placeGalaxy(stars, ['shop', 'cart', 'store'], 1600, 1000, none);
  assert.deepEqual(
    sky.map((s) => s.pmId),
    ['shop', 'cart'],
    'a PM with no stars has nothing to draw',
  );
  const [shop, cart] = sky;
  assert.deepEqual(
    shop.lit.map((s) => s.storyId),
    ['3', '5'],
  );
  assert.deepEqual(
    shop.faded.map((s) => s.storyId),
    ['1'],
  );
  assert.deepEqual(
    [...shop.lit, ...cart.lit].filter((s) => s.newest).map((s) => s.storyId),
    ['7'],
    'only the latest merge anywhere pulses',
  );
  assert.deepEqual({ x: shop.lit[0].x, y: shop.lit[0].y }, galaxySpot('pr-2003', 1600, 1000, none));
});

test('two PRs merged on one story are two stars in two places; a star with no PR is placed by its story', () => {
  const [shop] = placeGalaxy(
    [
      { ...star('100157', 'S', 1), pr: 7133 },
      { ...star('100157', 'S', 2), id: 'x', pr: 7148 },
      { ...star('100158', 'S', 3), id: 'y', pr: null },
    ],
    ['shop'],
    1600,
    1000,
    none,
  );
  assert.notDeepEqual([shop.lit[0].x, shop.lit[0].y], [shop.lit[1].x, shop.lit[1].y]);
  assert.deepEqual({ x: shop.lit[2].x, y: shop.lit[2].y }, galaxySpot('100158', 1600, 1000, none));
});

test('stars with no sprint fall into back-to-back 21-day windows ending now', () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const stars = [
    star('old', null, now - 50 * DAY),
    star('prev', null, now - 30 * DAY),
    star('cur2', null, now - 2 * DAY),
    star('cur1', null, now - 10 * DAY),
  ];
  const { current, previous } = sprintsFor(stars, 'shop', { current: null, previous: null }, now);
  assert.deepEqual(
    current.map((s) => s.storyId),
    ['cur1', 'cur2'],
  );
  assert.deepEqual(
    previous.map((s) => s.storyId),
    ['prev'],
  );
});

test('placeGalaxy reads each PM its own sky', () => {
  const other: SprintSky = { current: { ...sky.previous!, path: 'Cart\Sprint 2' }, previous: null };
  const stars = [
    star('a', sky.current!.path, 120, 'shop'),
    star('b', 'Cart\Sprint 2', 60, 'cart'),
    star('c', sky.current!.path, 130, 'cart'),
  ];
  const placed = placeGalaxy(stars, ['shop', 'cart'], 1600, 1000, none, { shop: sky, cart: other });
  assert.deepEqual(
    placed.map((p) => [p.pmId, p.lit.map((s) => s.storyId)]),
    [
      ['shop', ['a']],
      ['cart', ['b']],
    ],
  );
});
