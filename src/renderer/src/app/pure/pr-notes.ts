import type { PrLane, PrStageState } from '../../../../shared/types.ts';

export const STAGE_ORDER = ['ci', 'review', 'conflicts', 'merge'] as const;

export const STAGE_COLOR: Record<PrStageState, string> = {
  good: '#2fb344',
  busy: '#3b82f6',
  warn: '#f59e0b',
  bad: '#ef4444',
  pending: '#4b5563',
};

export interface StagePip {
  key: string;
  state: PrStageState;
  color: string;
  label: string;
  title: string;
}

/** The four gates in a fixed order, with whatever the monitor wrote for each. */
export function stagePips(stages: PrLane['stages']): StagePip[] {
  return STAGE_ORDER.map((key) => {
    const s = stages[key] ?? { state: 'pending' as const, label: '' };
    return {
      key,
      state: s.state,
      color: STAGE_COLOR[s.state],
      label: s.label,
      title: `${key}: ${s.label || s.state}`,
    };
  });
}

/** The first gate that is not green, so the row can say what is holding the PR up. */
export function firstProblem(stages: PrLane['stages']): StagePip | null {
  return stagePips(stages).find((p) => p.state !== 'good') ?? null;
}

/**
 * The monitor's note grows tick by tick. The newest tick, trimmed to one line, is what you
 * want at a glance; the whole history stays available on demand.
 */
export function noteGist(note: string | null, max = 110): string | null {
  if (!note) return null;
  const flat = note.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const ticks = flat.split(/(?=\bTick \d+:)/);
  let latest = ticks[ticks.length - 1].trim();
  latest = latest.replace(/^Tick \d+:\s*/, '');
  if (latest.length <= max) return latest;
  const cut = latest.slice(0, max);
  const sentence = cut.lastIndexOf('. ');
  return `${(sentence > max * 0.5 ? cut.slice(0, sentence + 1) : cut.trimEnd()).trimEnd()}…`;
}
