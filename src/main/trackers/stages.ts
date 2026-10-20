import { ADO_PALETTE } from '../../shared/ado-palette.ts';
import type { BoardColumn, OrbitStage, StageMap, TrackerItem } from '../../shared/types.ts';

/** What a tracker says a state broadly is: ADO state categories, Jira status categories. */
export type StateCategory = 'proposed' | 'in-progress' | 'resolved' | 'completed' | 'removed';

/** One state of one work item type, as ADO's state API returns it; colour is hex without the `#`. */
export interface TypeState {
  name: string;
  category: StateCategory;
  color: string | null;
}

export const STAGE_COLORS: Record<OrbitStage, string> = {
  'not-started': '#64748b',
  building: '#2fb344',
  'in-review': '#a78bfa',
  testing: '#f59e0b',
  done: '#059669',
  blocked: '#ef4444',
};

const BY_CATEGORY: Record<StateCategory, OrbitStage> = {
  proposed: 'not-started',
  'in-progress': 'building',
  resolved: 'testing',
  completed: 'done',
  removed: 'done',
};

/** Checked in this order, so "Blocked in Review" is blocked and "Testing Done" is testing. */
const BY_NAME: Array<[RegExp, OrbitStage]> = [
  [/\b(blocked|on hold)\b/i, 'blocked'],
  [/review|pull request/i, 'in-review'],
  [/\b(test|tests|testing|qa)\b/i, 'testing'],
  [/\b(done|closed|complete|completed)\b/i, 'done'],
  [/\b(to ?do|new|backlog)\b/i, 'not-started'],
  [/\b(in progress|doing|active)\b/i, 'building'],
];

/** The stage a column's name plainly says, or null when it doesn't. */
export function stageFromName(name: string): OrbitStage | null {
  return BY_NAME.find(([re]) => re.test(name))?.[1] ?? null;
}

/** A column's stage: the config's override, else what its name says, else its category, else building. */
export function stageOf(column: string, category: StateCategory | null, overrides?: StageMap): OrbitStage {
  return overrides?.[column] ?? stageFromName(column) ?? (category ? BY_CATEGORY[category] : 'building');
}

export function columnFor(stage: OrbitStage, columns: BoardColumn[]): BoardColumn | null {
  return columns.find((c) => c.stage === stage) ?? null;
}

/** Each item staged by its board column, or by its column's name when the board doesn't list it. */
export function withStages(items: TrackerItem[], columns: BoardColumn[], overrides?: StageMap): TrackerItem[] {
  const byName = new Map(columns.map((c) => [c.name, c.stage]));
  return items.map((i) => ({ ...i, stage: byName.get(i.column) ?? stageOf(i.column, null, overrides) }));
}

/**
 * An ADO board's columns: the palette's states in its order and colours, so a ring drawn before
 * trackers existed looks the same, then any state the palette doesn't name, in the order ADO's
 * per-type state lists first mention it, in ADO's own colour.
 */
export function adoColumns(typeStates: TypeState[][], overrides?: StageMap): BoardColumn[] {
  const api = new Map<string, TypeState>();
  for (const list of typeStates) for (const s of list) if (!api.has(s.name)) api.set(s.name, s);
  const named = new Set(ADO_PALETTE.map((p) => p.name));
  const listed = ADO_PALETTE.map((p) => ({
    name: p.name,
    stage: stageOf(p.name, api.get(p.name)?.category ?? null, overrides),
    color: p.color,
  }));
  const extra = [...api.values()]
    .filter((s) => !named.has(s.name))
    .map((s) => {
      const stage = stageOf(s.name, s.category, overrides);
      return { name: s.name, stage, color: s.color ? `#${s.color}` : STAGE_COLORS[stage] };
    });
  return [...listed, ...extra];
}
