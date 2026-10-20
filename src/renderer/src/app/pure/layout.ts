import type { AgentNode, Lane, LaneStatus } from '../../../../shared/types.ts';

export const STATUS_COLOR: Record<LaneStatus, string> = {
  starting: '#8fb8ff',
  working: '#2fb344',
  idle: '#3b82f6',
  'needs-you': '#f59e0b',
  error: '#ef4444',
  stopped: '#4b5563',
};
const CURATED: Array<[RegExp, string]> = [
  [/^angular$/, '#ef6b6b'],
  [/^nestjs$/, '#2fb344'],
  [/^debugger$/, '#ffd27a'],
  [/^qa-tester$/, '#3b82f6'],
  [/^review-/, '#a78bfa'],
  [/-analyst$/, '#2dd4bf'],
  [/^(general-purpose|fixer|claude)$/, '#c9b8ff'],
];
/** Distinct hues for agents nobody named a color for; a name always lands on the same one. */
const PALETTE = [
  '#f472b6',
  '#fb923c',
  '#facc15',
  '#a3e635',
  '#34d399',
  '#22d3ee',
  '#60a5fa',
  '#818cf8',
  '#e879f9',
  '#fb7185',
  '#f97316',
  '#4ade80',
];
export const UNKNOWN_AGENT_COLOR = '#9aa3b2';

export function hashName(name: string): number {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function corePositions(
  count: number,
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  const step = width / (count + 1);
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round(step * (i + 1)),
    y: Math.round(height * 0.55),
  }));
}

/** Big enough for a two-line name at rest; grows with the agents at work, within reason. */
export function coreRadius(agentCount: number): number {
  return Math.min(78, 44 + agentCount * 6);
}

export function statusColor(status: LaneStatus): string {
  return STATUS_COLOR[status];
}

/**
 * The color an agent's satellite wears: what its agent file declares, else a curated pick, else a
 * stable hue from its name. Only an agent with no type at all is grey.
 */
export function dotColor(agentType: string | null, declared: Record<string, string> = {}): string {
  if (!agentType) return UNKNOWN_AGENT_COLOR;
  const own = declared[agentType];
  if (own) return own;
  for (const [re, c] of CURATED) if (re.test(agentType)) return c;
  return PALETTE[hashName(agentType.toLowerCase()) % PALETTE.length];
}

/** Every agent type present on the stage right now, with its color, for the legend. */
export function agentLegend(
  lanes: Lane[],
  declared: Record<string, string> = {},
): Array<{ name: string; color: string }> {
  const names = new Set<string>();
  for (const lane of lanes) for (const a of lane.agents) if (a.agentType) names.add(a.agentType);
  return [...names].sort().map((name) => ({ name, color: dotColor(name, declared) }));
}

/** An SVG arc on a circle of `radius` from one angle to another, in degrees clockwise from 3 o'clock. */
export function arcPath(radius: number, fromDeg: number, toDeg: number): string {
  const p = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(Math.cos(a) * radius).toFixed(2)} ${(Math.sin(a) * radius).toFixed(2)}`;
  };
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg > fromDeg ? 1 : 0;
  return `M ${p(fromDeg)} A ${radius} ${radius} 0 ${large} ${sweep} ${p(toDeg)}`;
}

/**
 * How flat a satellite's orbit looks: the plane is seen from above at an angle, so its height
 * shrinks to this share of its width and the near side sits low on the screen.
 */
export const ORBIT_TILT = 0.42;

export const MOON_RADIUS = 20;
/** How far a story moon reaches from its centre, the sweep it shows while asking included. */
export const MOON_REACH = MOON_RADIUS + 7;

/**
 * How far out `count` evenly spaced moons must circle so no two ever touch on screen. Neighbours
 * come closest at the sides of the flattened ring, 2 · r · tilt · sin(π / count) apart.
 */
export function spreadOrbit(base: number, count: number): number {
  if (count < 2) return base;
  return Math.max(base, Math.ceil(MOON_REACH / (ORBIT_TILT * Math.sin(Math.PI / count))));
}

/** Half an ellipse: the far half runs over the top, the near half under the bottom. */
export function halfEllipse(rx: number, ry: number, half: 'far' | 'near'): string {
  return half === 'far'
    ? `M ${-rx} 0 A ${rx} ${ry} 0 0 1 ${rx} 0`
    : `M ${rx} 0 A ${rx} ${ry} 0 0 1 ${-rx} 0`;
}

/**
 * A clip that hides whatever crosses the far half of a globe of radius `r`, so a satellite on
 * the back of its orbit slips behind the core. Even-odd cuts the half-disk out of a huge box.
 */
export function occluderPath(r: number): string {
  return `M -4000 -4000 H 4000 V 4000 H -4000 Z ${halfEllipse(r, r, 'far')} Z`;
}

/** The symbol an agent's satellite wears: a glyph for the usual suspects, else the first letter of its name. */
export function agentGlyph(agentType: string | null): string {
  if (!agentType) return '·';
  const t = agentType.toLowerCase();
  if (t === 'angular') return '</>';
  if (t === 'nestjs') return '{}';
  if (t === 'debugger') return '!?';
  if (t === 'qa-tester') return '✓';
  if (t.startsWith('review-')) return '⌕';
  if (t.endsWith('-analyst')) return '◫';
  if (t === 'architect') return '△';
  if (t.endsWith('-api')) return '⇄';
  if (t === 'ux-designer') return '✎';
  if (t === 'test-data-scout') return '⚲';
  if (t.endsWith('-pm')) return '☰';
  return agentType.charAt(0).toUpperCase();
}

/** How much a lane pulls toward the middle of the stage: the people working for it, and whether it is awake. */
export function laneMass(lane: Pick<Lane, 'status' | 'agents'>): number {
  const working = lane.agents.filter((a) => a.state === 'working').length;
  const awake =
    lane.status === 'working' || lane.status === 'starting'
      ? 1
      : lane.status === 'needs-you'
        ? 0.75
        : 0;
  return working + awake;
}

/** The stage's background for an hour of the day: cool in the morning, neutral midday, violet by evening, deep at night. */
export function stageTint(hour: number, dark = true): string {
  if (hour >= 6 && hour < 11) return dark ? '#0e1420' : '#eef3fb';
  if (hour >= 11 && hour < 17) return dark ? '#0f1218' : '#f4f6fa';
  if (hour >= 17 && hour < 22) return dark ? '#120f1c' : '#f6f0f7';
  return dark ? '#0b0d14' : '#e9ebf2';
}

/** Whether a lane's bubble is still worth showing: the lane is busy or waiting on you, or it spoke a moment ago. */
export function bubbleVisible(lane: Lane, now: number, lingerMs: number): boolean {
  if (!lane.bubble || lane.status === 'stopped' || lane.status === 'error') return false;
  if (lane.status === 'working' || lane.status === 'starting' || lane.status === 'needs-you')
    return true;
  return now - lane.bubble.at < lingerMs;
}

export function liveAgents(lane: Lane, now: number, fadeMs: number): AgentNode[] {
  return lane.agents.filter(
    (a) => a.state === 'working' || (a.endedAt !== null && now - a.endedAt < fadeMs),
  );
}

export function formatAge(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * A lane's spend for a glance: the CLI's exact figure, plus the running guess for the turn in
 * progress when there is one (`$4.73 +~$0.35`). A `~` alone means the CLI itself was guessing.
 */
export function formatCost(lane: Pick<Lane, 'costUsd' | 'costInflightUsd' | 'costBasis'>): string {
  const exact = `${lane.costBasis === 'unknown' ? '~' : ''}$${lane.costUsd.toFixed(2)}`;
  return lane.costInflightUsd >= 0.005 ? `${exact} +~$${lane.costInflightUsd.toFixed(2)}` : exact;
}

/** Today's total across lanes: what finished turns spent, plus every turn still running. */
export function formatSpentToday(
  spentUsd: number,
  lanes: Array<Pick<Lane, 'costInflightUsd'>>,
): string {
  const inflight = lanes.reduce((s, l) => s + l.costInflightUsd, 0);
  return `${inflight >= 0.005 ? '~' : ''}$${(spentUsd + inflight).toFixed(2)}`;
}
