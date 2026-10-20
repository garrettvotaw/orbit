import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stage, type Body, type GravityField } from './physics.ts';

const body = (id: string, x: number, mass: number, radius = 60, y = 440): Body => ({
  id,
  x,
  y,
  vx: 0,
  vy: 0,
  mass,
  radius,
});
const field: GravityField = { kind: 'gravity', cx: 600, cy: 440, minX: 0, maxX: 1200, gap: 30 };
const center = (b: Body) => Math.abs(b.x - field.cx);
const settled = (bodies: Body[], f: GravityField = field): Body[] => {
  const stage = new Stage(bodies, f);
  stage.settle();
  assert.ok(stage.atRest(), 'came to rest');
  return stage.bodies();
};
const apart = (bodies: Body[], gap: number, slack = 6) => {
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(
        d >= a.radius + b.radius + gap - slack,
        `${a.id} and ${b.id} overlap: ${d.toFixed(0)}`,
      );
    }
};

test('bodies keep their config order whatever they weigh, and the row centres on the stage', () => {
  const end = settled([body('heavy', 200, 5), body('a', 600, 1), body('b', 1000, 1)]);
  assert.deepEqual(
    [...end].sort((x, y) => x.x - y.x).map((b) => b.id),
    ['heavy', 'a', 'b'],
  );
  assert.ok(
    Math.abs(end[1].x - field.cx) < 5,
    `the middle one on the centre: ${end[1].x.toFixed(0)}`,
  );
  for (const b of end)
    assert.ok(Math.abs(b.y - field.cy) < 12, `${b.id} back on the row: ${b.y.toFixed(0)}`);
  apart(end, field.gap);
});

test('equal bodies spread out evenly around the middle', () => {
  const end = settled([body('a', 300, 1), body('b', 600, 1), body('c', 900, 1)]);
  assert.ok(end[0].x < end[1].x && end[1].x < end[2].x, 'order kept');
  assert.ok(Math.abs(end[1].x - 600) < 5, `middle one on the centre: ${end[1].x.toFixed(0)}`);
  assert.ok(Math.abs(end[1].x - end[0].x - (end[2].x - end[1].x)) < 8, 'same spacing each side');
});

test('a body that gets busier stays where it is, and so do its neighbours', () => {
  const bodies = [body('a', 450, 1), body('b', 600, 1), body('c', 750, 1)];
  const stage = new Stage(bodies, field);
  stage.settle();
  const before = bodies.map((b) => b.x);
  bodies[0].mass = 6;
  stage.setBodies(bodies);
  stage.settle();
  bodies.forEach((b, i) =>
    assert.ok(Math.abs(b.x - before[i]) < 1, `${b.id} did not move: ${b.x.toFixed(1)}`),
  );
});

test('bodies stay on the stage however tight it is', () => {
  const tight: GravityField = { ...field, minX: 0, maxX: 420 };
  const end = settled([body('a', 50, 1), body('b', 350, 1), body('c', 200, 1)], tight);
  for (const b of end)
    assert.ok(b.x >= b.radius - 0.01 && b.x <= 420 - b.radius + 0.01, `${b.id} inside: ${b.x}`);
});

test('anchors ease each body to its own spot without overshooting, and the stage then rests', () => {
  const targets = [
    { x: 200, y: 300 },
    { x: 800, y: 700 },
  ];
  const bodies = [body('a', 600, 1), body('b', 600, 3)];
  const stage = new Stage(bodies, { kind: 'anchors', targets });
  let minA = Infinity;
  let maxB = -Infinity;
  while (stage.step()) {
    minA = Math.min(minA, bodies[0].x);
    maxB = Math.max(maxB, bodies[1].x);
  }
  assert.ok(
    Math.abs(bodies[0].x - 200) < 1 && Math.abs(bodies[0].y - 300) < 1,
    `a at its spot: ${bodies[0].x}`,
  );
  assert.ok(
    Math.abs(bodies[1].x - 800) < 1 && Math.abs(bodies[1].y - 700) < 1,
    `b at its spot: ${bodies[1].x}`,
  );
  assert.ok(
    minA > 200 - 8 && maxB < 800 + 8,
    `no visible overshoot: ${minA.toFixed(1)} ${maxB.toFixed(1)}`,
  );
  assert.ok(stage.atRest());
});

test('coming home from the focus view, nothing jumps: no body moves more than a few px a frame', () => {
  const bodies = [
    body('a', 60, 1, 84, 900),
    body('b', 150, 4, 110, 900),
    body('c', 240, 1, 84, 900),
    body('d', 330, 1, 84, 900),
  ];
  const stage = new Stage(bodies, {
    kind: 'anchors',
    targets: bodies.map((b) => ({ x: b.x, y: b.y })),
  });
  stage.settle();
  stage.setField({ ...field, maxX: 1280 });
  let biggest = 0;
  let last = bodies.map((b) => ({ x: b.x, y: b.y }));
  while (stage.step()) {
    bodies.forEach(
      (b, i) => (biggest = Math.max(biggest, Math.hypot(b.x - last[i].x, b.y - last[i].y))),
    );
    last = bodies.map((b) => ({ x: b.x, y: b.y }));
  }
  assert.ok(biggest < 40, `biggest single-frame move ${biggest.toFixed(1)}px`);
  assert.deepEqual(
    [...bodies].sort((x, y) => x.x - y.x).map((b) => b.id),
    ['a', 'b', 'c', 'd'],
    'back in config order, the heavy one too',
  );
  apart(bodies, field.gap);
});
