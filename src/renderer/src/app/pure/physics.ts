import { forceSimulation, forceX, forceY, type Simulation } from 'd3-force';

/** A lane on the stage. The simulation moves these in place. */
export interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** More work makes a lane heavier: it is pulled to its place harder. Its place never depends on it. */
  mass: number;
  radius: number;
}

/** The home row: every body keeps its config-order place, the row is centred, and none overlap. */
export interface GravityField {
  kind: 'gravity';
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
  gap: number;
}
/** The focus view: every body eases to its own spot. */
export interface AnchorField {
  kind: 'anchors';
  targets: Array<{ x: number; y: number }>;
}
export type Field = GravityField | AnchorField;

export interface Tuning {
  /** Pull toward a body's place in the row, by its mass, as d3 force strength. */
  pull: (mass: number) => number;
  /** Pull back to the row's baseline, or up over a neighbour while passing. */
  baseline: number;
  /** Pull to a spot in the focus view. */
  anchor: number;
  /** How firmly two bodies on the row are eased apart when their cores meet. */
  collide: number;
  /** Share of velocity lost each tick; higher is syrupier. Pulls above ~0.09 start to overshoot. */
  drag: number;
  /** Slower than this, in px per tick, counts as still. */
  rest: number;
  /** Furthest any body moves in one frame, so a long glide is steady rather than a lurch. */
  maxStep: number;
}

export const TUNING: Tuning = {
  pull: (mass) => Math.min(0.08, 0.035 + 0.01 * mass),
  baseline: 0.08,
  anchor: 0.06,
  collide: 0.5,
  drag: 0.45,
  rest: 0.05,
  maxStep: 22,
};

/** Ticks in a row everything must be still before the stage counts as at rest. */
const STILL_TICKS = 3;

/**
 * Where each body belongs on the home row: in config order, packed shoulder to shoulder, with the
 * row centred on the stage. Work never reorders the row, so a PM and the constellation above it
 * stay put; the row only eases when a lane comes, goes, or grows.
 */
export function restingPlaces(bodies: Body[], field: GravityField): number[] {
  const n = bodies.length;
  if (!n) return [];
  const span = field.maxX - field.minX;
  const across = bodies.reduce((sum, b) => sum + 2 * b.radius, 0);
  const gap = n > 1 ? Math.min(field.gap, Math.max(0, (span - across) / (n - 1))) : 0;
  const rel: number[] = [];
  let x = 0;
  for (const b of bodies) {
    rel.push(x + b.radius);
    x += 2 * b.radius + gap;
  }
  const width = x - gap;
  const shift = Math.max(Math.min(field.cx - width / 2, field.maxX - width), field.minX);
  return rel.map((r) => r + shift);
}

/**
 * The stage's physics: a d3-force simulation over the lanes, used as an integrator with drag
 * rather than a cooling layout. Bodies are pulled toward where they belong, with momentum, so
 * they ease in and out of a move; the stage is at rest once nothing has moved for a few ticks.
 */
export class Stage {
  readonly #sim: Simulation<Body, undefined>;
  readonly tuning: Tuning;
  #field: Field;
  #still = 0;

  constructor(bodies: Body[], field: Field, tuning: Tuning = TUNING) {
    this.tuning = tuning;
    this.#field = field;
    this.#sim = forceSimulation(bodies).stop().velocityDecay(tuning.drag).alphaDecay(0).alpha(1);
    this.#apply();
  }

  bodies(): Body[] {
    return this.#sim.nodes();
  }

  field(): Field {
    return this.#field;
  }

  /** Swap in the current lanes; the same objects keep their place and speed. */
  setBodies(bodies: Body[]): void {
    this.#sim.nodes(bodies);
    this.#apply();
    this.#still = 0;
  }

  setField(field: Field): void {
    this.#field = field;
    this.#apply();
    this.#still = 0;
  }

  atRest(): boolean {
    return this.#still >= STILL_TICKS;
  }

  /** Advance one frame's worth. Returns true while there is still motion to show. */
  step(frames = 1): boolean {
    for (let i = 0; i < frames && !this.atRest(); i++) this.#tick();
    return !this.atRest();
  }

  /** Run to a standstill, for a first paint or a reader who turned motion off. */
  settle(maxTicks = 1000): void {
    for (let i = 0; i < maxTicks && !this.atRest(); i++) this.#tick();
  }

  #tick(): void {
    const nodes = this.#sim.nodes();
    const from = nodes.map((b) => ({ x: b.x, y: b.y }));
    this.#sim.tick();
    const most = this.tuning.maxStep;
    let fastest = 0;
    nodes.forEach((b, i) => {
      const dx = b.x - from[i].x;
      const dy = b.y - from[i].y;
      const moved = Math.hypot(dx, dy);
      if (moved > most) {
        const k = most / moved;
        b.x = from[i].x + dx * k;
        b.y = from[i].y + dy * k;
        b.vx = dx * k;
        b.vy = dy * k;
      }
      fastest = Math.max(fastest, Math.min(moved, most));
    });
    this.#clamp();
    this.#still = fastest < this.tuning.rest ? this.#still + 1 : 0;
  }

  #apply(): void {
    const t = this.tuning;
    const f = this.#field;
    if (f.kind === 'gravity') {
      this.#sim.force('row', rowForce(f, t)).force('x', null).force('y', null);
    } else {
      const at = (i: number) => f.targets[i] ?? { x: 0, y: 0 };
      this.#sim
        .force('row', null)
        .force('x', forceX<Body>((_, i) => at(i).x).strength(t.anchor))
        .force('y', forceY<Body>((_, i) => at(i).y).strength(t.anchor));
    }
  }

  /** Keep every body on the stage. */
  #clamp(): void {
    const f = this.#field;
    if (f.kind !== 'gravity') return;
    for (const b of this.#sim.nodes()) {
      const lo = f.minX + b.radius;
      const hi = f.maxX - b.radius;
      if (b.x < lo) {
        b.x = lo;
        b.vx = 0;
      } else if (b.x > hi) {
        b.x = hi;
        b.vx = 0;
      }
    }
  }
}

/** How far above the baseline a body must be before it counts as up in the air. */
const AIRBORNE = 4;

/**
 * The home-row force: each body is drawn to its place along the row and back down to the
 * baseline. When two neighbours are on the wrong sides of each other, the one with further to
 * go is drawn up over the other instead, and stays up until its core is clear of its
 * neighbours, so the row never has to shove itself apart to re-sort.
 */
function rowForce(f: GravityField, t: Tuning) {
  let nodes: Body[] = [];
  let places: number[] = [];
  const force = (alpha: number) => {
    const lift = new Array<number>(nodes.length).fill(0);
    const byX = nodes.map((_, i) => i).sort((a, b) => nodes[a].x - nodes[b].x);
    for (let k = 0; k + 1 < byX.length; k++) {
      const i = byX[k];
      const j = byX[k + 1];
      const a = nodes[i];
      const b = nodes[j];
      const room = a.radius + b.radius + f.gap;
      const d = b.x - a.x;
      if (places[j] < places[i] && d < room * 1.6) {
        const toGo = (n: number) => Math.abs(places[n] - nodes[n].x);
        const up =
          toGo(i) > toGo(j) * 1.1 ? i : toGo(j) > toGo(i) * 1.1 ? j : a.mass <= b.mass ? i : j;
        const over = up === i ? b : a;
        lift[up] = Math.max(lift[up], over.radius + nodes[up].radius / 2);
      }
      // Still up from a pass and not yet clear: stay up rather than land on a neighbour.
      if (d < a.radius + b.radius)
        for (const n of [i, j])
          if (nodes[n].y < f.cy - AIRBORNE) lift[n] = Math.max(lift[n], f.cy - nodes[n].y);
    }
    // Two bodies on the row whose cores meet are eased apart, the lighter giving most of the
    // ground. A body still off the row, above or below, neither shoves nor is shoved.
    for (let k = 0; k + 1 < byX.length; k++) {
      const i = byX[k];
      const j = byX[k + 1];
      const a = nodes[i];
      const b = nodes[j];
      if (lift[i] || lift[j] || Math.abs(a.y - f.cy) > AIRBORNE || Math.abs(b.y - f.cy) > AIRBORNE)
        continue;
      const excess = a.radius + b.radius - (b.x - a.x);
      if (excess <= 0) continue;
      const total = a.mass + b.mass;
      a.vx -= excess * (b.mass / total) * t.collide;
      b.vx += excess * (a.mass / total) * t.collide;
    }
    nodes.forEach((b, i) => {
      b.vx += (places[i] - b.x) * t.pull(b.mass) * alpha;
      b.vy += (f.cy - lift[i] - b.y) * t.baseline * alpha;
    });
  };
  force.initialize = (all: Body[]) => {
    nodes = all;
    places = restingPlaces(all, f);
  };
  return force;
}
