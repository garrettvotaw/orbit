import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentGlyph,
  agentLegend,
  arcPath,
  halfEllipse,
  occluderPath,
  laneMass,
  stageTint,
  bubbleVisible,
  corePositions,
  coreRadius,
  statusColor,
  dotColor,
  liveAgents,
  MOON_REACH,
  ORBIT_TILT,
  spreadOrbit,
  UNKNOWN_AGENT_COLOR,
} from './layout.ts';
import type { AgentNode, Lane } from '../../../../shared/types.ts';

test('corePositions spreads cores evenly on the baseline', () => {
  const p = corePositions(3, 1200, 800);
  assert.deepEqual(
    p.map((q) => q.x),
    [300, 600, 900],
  );
  assert.ok(p.every((q) => q.y === 440));
});

test('coreRadius clamps', () => {
  assert.equal(coreRadius(0), 44);
  assert.equal(coreRadius(3), 62);
  assert.equal(coreRadius(50), 78);
});

test('status and dot colors', () => {
  assert.equal(statusColor('needs-you'), '#f59e0b');
  assert.equal(dotColor('angular'), '#ef6b6b');
  assert.equal(dotColor('review-erp-mapper'), '#a78bfa');
  assert.equal(dotColor(null), UNKNOWN_AGENT_COLOR);
});

test('every named agent gets a stable, non-grey color; a declared color wins', () => {
  for (const name of [
    'architect',
    'erp-api',
    'ux-designer',
    'test-data-scout',
    'story-analyzer',
    'Explore',
  ]) {
    const c = dotColor(name);
    assert.notEqual(c, UNKNOWN_AGENT_COLOR, name);
    assert.equal(dotColor(name), c, `${name} is stable`);
    assert.match(c, /^#[0-9a-f]{6}$/);
  }
  assert.notEqual(dotColor('architect'), dotColor('erp-api'));
  assert.equal(dotColor('erp-api', { 'erp-api': '#123456' }), '#123456');
  assert.equal(dotColor('angular', { angular: '#123456' }), '#123456');
});

test('agentLegend lists the agent types on stage, sorted, with their colors', () => {
  const agent = (agentType: string | null) => ({ agentType }) as AgentNode;
  const lanes = [
    { agents: [agent('nestjs'), agent('architect'), agent(null)] },
    { agents: [agent('angular'), agent('nestjs')] },
  ] as Lane[];
  assert.deepEqual(agentLegend(lanes, { architect: '#010203' }), [
    { name: 'angular', color: '#ef6b6b' },
    { name: 'architect', color: '#010203' },
    { name: 'nestjs', color: '#2fb344' },
  ]);
  assert.deepEqual(agentLegend([]), []);
});

test('bubbleVisible while the lane works or waits on you, or briefly after it last spoke', () => {
  const bubble = { kind: 'said' as const, text: 'Deriving the board', agentType: null, at: 1_000 };
  const lane = (status: Lane['status'], b = bubble) => ({ status, bubble: b }) as Lane;
  assert.equal(bubbleVisible(lane('working'), 500_000, 20_000), true);
  assert.equal(bubbleVisible(lane('starting'), 500_000, 20_000), true);
  assert.equal(bubbleVisible(lane('needs-you'), 500_000, 20_000), true);
  assert.equal(bubbleVisible(lane('idle'), 15_000, 20_000), true);
  assert.equal(bubbleVisible(lane('idle'), 25_000, 20_000), false);
  assert.equal(bubbleVisible(lane('stopped'), 1_000, 20_000), false);
  assert.equal(bubbleVisible(lane('error'), 1_000, 20_000), false);
  assert.equal(bubbleVisible({ status: 'working', bubble: null } as Lane, 1_000, 20_000), false);
});

test('liveAgents keeps working agents and recently finished ones', () => {
  const a = (taskId: string, state: AgentNode['state'], endedAt: number | null): AgentNode => ({
    taskId,
    toolUseId: null,
    agentType: null,
    description: '',
    state,
    summary: null,
    lastTool: null,
    depth: 1,
    startedAt: 0,
    endedAt,
    tokens: 0,
  });
  const lane = {
    agents: [a('w', 'working', null), a('fresh', 'done', 95), a('old', 'done', 10)],
  } as Lane;
  assert.deepEqual(
    liveAgents(lane, 100, 20).map((x) => x.taskId),
    ['w', 'fresh'],
  );
});

test('agentGlyph has a symbol for the usual suspects and a letter for the rest', () => {
  assert.equal(agentGlyph('angular'), '</>');
  assert.equal(agentGlyph('nestjs'), '{}');
  assert.equal(agentGlyph('review-erp-mapper'), '⌕');
  assert.equal(agentGlyph('shop-pm'), '☰');
  assert.equal(agentGlyph('story-analyzer'), 'S');
  assert.equal(agentGlyph(null), '·');
});

test('laneMass counts working agents and whether the lane is awake', () => {
  const agents = (n: number) =>
    Array.from({ length: n }, () => ({ state: 'working' }) as AgentNode);
  assert.equal(laneMass({ status: 'working', agents: agents(3) }), 4);
  assert.equal(laneMass({ status: 'needs-you', agents: [] }), 0.75);
  assert.equal(laneMass({ status: 'idle', agents: [{ state: 'done' } as AgentNode] }), 0);
  assert.equal(laneMass({ status: 'stopped', agents: [] }), 0);
});

test('stageTint follows the hour', () => {
  assert.equal(stageTint(8), '#0e1420');
  assert.equal(stageTint(13), '#0f1218');
  assert.equal(stageTint(19), '#120f1c');
  assert.equal(stageTint(2), '#0b0d14');
  assert.equal(stageTint(23), '#0b0d14');
});

test('arcPath draws a short clockwise arc on the circle', () => {
  assert.equal(arcPath(10, 0, 90), 'M 10.00 0.00 A 10 10 0 0 1 0.00 10.00');
  assert.equal(arcPath(10, -22, -4).startsWith('M 9.27 -3.75 A 10 10 0 0 1 '), true);
  assert.ok(arcPath(10, 0, 270).includes(' 0 1 1 '), 'past a half turn uses the large arc');
});

test('stageTint has a light palette too', () => {
  assert.equal(stageTint(8, false), '#eef3fb');
  assert.equal(stageTint(13, false), '#f4f6fa');
  assert.equal(stageTint(19, false), '#f6f0f7');
  assert.equal(stageTint(2, false), '#e9ebf2');
  assert.equal(stageTint(13, true), stageTint(13));
});

test('halfEllipse draws the far half over the top and the near half under the bottom', () => {
  assert.equal(halfEllipse(30, 8, 'far'), 'M -30 0 A 30 8 0 0 1 30 0');
  assert.equal(halfEllipse(30, 8, 'near'), 'M 30 0 A 30 8 0 0 1 -30 0');
});

test('occluderPath keeps everything but the far half of the globe', () => {
  // A huge outer box, then the upper half-disk cut out of it by the even-odd rule.
  assert.equal(
    occluderPath(60),
    'M -4000 -4000 H 4000 V 4000 H -4000 Z M -60 0 A 60 60 0 0 1 60 0 Z',
  );
});

test('spreadOrbit keeps evenly spaced moons from ever touching on the flattened ring', () => {
  const base = 111;
  assert.equal(spreadOrbit(base, 0), base);
  assert.equal(spreadOrbit(base, 1), base);
  assert.equal(spreadOrbit(base, 4), base, 'four moons already fit on a small ring');
  for (let n = 2; n <= 12; n++) {
    const r = spreadOrbit(base, n);
    let closest = Infinity;
    for (let step = 0; step < 360; step++) {
      const at = (i: number) => {
        const a = ((step + (360 * i) / n) * Math.PI) / 180;
        return [r * Math.cos(a), r * ORBIT_TILT * Math.sin(a)];
      };
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const [ax, ay] = at(i);
          const [bx, by] = at(j);
          closest = Math.min(closest, Math.hypot(ax - bx, ay - by));
        }
    }
    assert.ok(
      closest >= 2 * MOON_REACH - 0.01,
      `${n} moons at r ${r} come ${closest.toFixed(1)} apart`,
    );
  }
  assert.ok(spreadOrbit(base, 8) > base, 'eight moons push the ring out');
});
