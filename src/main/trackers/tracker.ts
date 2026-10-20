import type { BoardColumn, OrbitStage, SprintWindow, TrackerItem, TrackerRef } from '../../shared/types.ts';

export interface StoryComment {
  author: string;
  at: number;
  text: string;
}

/** One story in full, as get_story hands it to an agent. */
export interface StoryDetail {
  item: TrackerItem;
  description: string;
  /** Null when the tracker has no field for it; the description usually carries it then. */
  acceptance: string | null;
  comments: StoryComment[];
  children: TrackerItem[];
  links: Array<{ title: string; url: string }>;
}

/** What Orbit asks of any tracker: one adapter per project, built from its config. */
export interface Tracker {
  readonly ref: TrackerRef;
  /** The open stories under the PM's scope, and the board's columns in the tracker's order. */
  board(): Promise<{ columns: BoardColumn[]; items: TrackerItem[] }>;
  /** Stories under the scope changed since `since` (a `YYYY-MM-DD` day), closed ones included. */
  shipped(since: string): Promise<TrackerItem[]>;
  sprints(): Promise<SprintWindow[]>;
  story(id: string): Promise<StoryDetail>;
  /** Moves the story to the first column with that stage and returns that column. */
  move(id: string, stage: OrbitStage, note?: string): Promise<BoardColumn>;
  comment(id: string, text: string): Promise<void>;
}

/** The tracker refused who we are; the card for this ref offers the fix. */
export class TrackerAuthError extends Error {
  readonly ref: TrackerRef;

  constructor(ref: TrackerRef, message: string) {
    super(message);
    this.name = 'TrackerAuthError';
    this.ref = ref;
  }
}

/** A move the board can't make from where the story is; nothing was changed. */
export class TrackerMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerMoveError';
  }
}

export function noColumnError(stage: OrbitStage, columns: BoardColumn[]): TrackerMoveError {
  const list = columns.map((c) => `${c.name} (${c.stage})`).join(', ');
  return new TrackerMoveError(`No column on this board is "${stage}". Its columns: ${list}`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** Tracker HTML (ADO fields, Jira's rendered fields) as plain text an agent can read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join('\n')
    .trim();
}
