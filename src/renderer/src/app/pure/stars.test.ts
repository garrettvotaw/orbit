import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leanFor, starfield } from './stars.ts';

test('starfield is deterministic, fits the stage, and mixes two layers', () => {
  const a = starfield(1200, 800);
  const b = starfield(1200, 800);
  assert.deepEqual(a, b);
  assert.equal(a.length, 220);
  assert.ok(a.every((s) => s.x >= 0 && s.x <= 1200 && s.y >= 0 && s.y <= 800));
  assert.ok(a.some((s) => s.layer === 1) && a.some((s) => s.layer === 0));
  // Bright enough to read on the stage: even the faintest far star, and a few at full.
  assert.ok(a.every((s) => s.opacity >= 0.35 && s.opacity <= 1 && s.r > 0));
  assert.ok(a.some((s) => s.opacity === 1));
  assert.notDeepEqual(starfield(1200, 800, 220, 8), a, 'another seed is another sky');
  assert.equal(starfield(10, 10, 0).length, 0);
});

test('the sky leans away from the pointer as one piece: the galaxy with the far stars, near stars a little more', () => {
  assert.deepEqual(leanFor({ x: 0, y: 0 }, 'far'), { x: 0, y: 0 });
  assert.deepEqual(leanFor({ x: 1, y: -1 }, 'far'), { x: -10, y: 6 });
  assert.deepEqual(leanFor({ x: -0.5, y: 0.5 }, 'near'), { x: 8, y: -5 });
  const far = leanFor({ x: 1, y: 1 }, 'far');
  const near = leanFor({ x: 1, y: 1 }, 'near');
  assert.ok(
    Math.abs(near.x) > Math.abs(far.x) && Math.abs(near.y) > Math.abs(far.y),
    'near moves more',
  );
});
