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
  /** Hyperlinks: pages the story points at, not other stories. */
  links: Array<{ title: string; url: string }>;
  /** A bug's steps to reproduce, when the tracker has a field for them. */
  reproSteps: string | null;
  parent: { item: TrackerItem; description: string; acceptance: string | null } | null;
  related: Array<{ kind: RelationKind; item: TrackerItem }>;
  attachments: Array<{ name: string; url: string }>;
}

/**
 * How another story relates to this one, read from this story's side: `blocks` means this one blocks
 * it, `blocked-by` that it blocks this one, `duplicate-of` that this one duplicates it, and
 * `duplicate` that it duplicates this one.
 */
export type RelationKind = 'related' | 'blocks' | 'blocked-by' | 'duplicate' | 'duplicate-of';

/** What Orbit asks of any tracker: one adapter per project, built from its config. */
export interface Tracker {
  readonly ref: TrackerRef;
  /** The open stories under the PM's scope, and the board's columns in the tracker's order. */
  board(): Promise<{ columns: BoardColumn[]; items: TrackerItem[] }>;
  /** Stories under the scope changed since `since` (a `YYYY-MM-DD` day), closed ones included. */
  shipped(since: string): Promise<TrackerItem[]>;
  sprints(): Promise<SprintWindow[]>;
  story(id: string): Promise<StoryDetail>;
  /** Moves the story to the first column with that stage (or the column named) and returns that column. */
  move(id: string, stage: OrbitStage, opts?: MoveOptions): Promise<BoardColumn>;
  /** Posts a comment; with a marker, edits the one Orbit posted earlier with that marker, if it's still there. */
  comment(id: string, text: string, opts?: CommentOptions): Promise<CommentResult>;
  /** One of the story's attachments, by name, as bytes. */
  attachment(id: string, name: string): Promise<StoryFile>;
  /** Links two stories, read from the first: `duplicate` means it duplicates the other, `blocks` that it blocks it. */
  link(id: string, otherId: string, kind: LinkKind): Promise<void>;
  /** Uploads a file onto the story and returns where the tracker keeps it. */
  attach(id: string, file: { name: string; data: Uint8Array }): Promise<{ name: string; url: string }>;
}

export type LinkKind = 'duplicate' | 'related' | 'blocks';

export interface CommentOptions {
  /** Names one comment Orbit keeps up to date, like a plan or a status, instead of adding another. */
  marker?: string;
}

/** `unmarked`: posted or edited, but the tracker stored it without its marker, so the next one can't find it. */
export type CommentResult = 'posted' | 'updated' | 'unmarked';

/** How ADO and GitHub carry a marker: an HTML comment, hidden when the text renders. */
export function markerTag(marker: string): string {
  return `<!-- orbit:${marker} -->`;
}

/** The text with its marker, when it has one. */
export function withMarker(text: string, marker: string | undefined): string {
  return marker ? `${text}\n${markerTag(marker)}` : text;
}

export interface StoryFile {
  name: string;
  mimeType: string;
  /** The file, or its first MAX_ATTACHMENT_READ bytes when it is longer. */
  data: Uint8Array;
  /** The whole file's size in bytes; null when it was cut short and the tracker didn't say. */
  size: number | null;
}

/** The most of an attachment Orbit downloads: an image it can show, or the head of a long log. */
export const MAX_ATTACHMENT_READ = 5 * 1024 * 1024;

/** A response body as readCapped takes it. */
export interface CappedBody {
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}

/** A body read up to `max` bytes; past that, the stream is cancelled so the rest never downloads. */
export async function readCapped(res: CappedBody, max: number): Promise<{ data: Uint8Array; size: number | null }> {
  const header = res.headers?.get('content-length');
  const length = header && /^\d+$/.test(header) ? Number(header) : null;
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    return { data: all.subarray(0, max), size: all.length };
  }
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got <= max) {
    const { done, value } = await reader.read();
    if (done) return { data: joined(chunks, got), size: got };
    chunks.push(value);
    got += value.length;
  }
  await reader.cancel();
  return { data: joined(chunks, got).subarray(0, max), size: length };
}

function joined(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Something this tracker has no way to do; the message says what to do instead. */
export class TrackerUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerUnsupportedError';
  }
}

/** No attachment by that name, with the names the story does have. */
export function noSuchAttachment(id: string, name: string, names: string[]): TrackerUnsupportedError {
  const has = names.length ? `It has: ${names.join(', ')}` : 'It has none.';
  return new TrackerUnsupportedError(`No attachment "${name}" on ${id}. ${has}`);
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/** A file's type: the server's, unless it only says octet-stream, else the extension's. */
export function mimeOf(name: string, header: string | null | undefined): string {
  const said = header?.split(';')[0].trim().toLowerCase();
  if (said && said !== 'application/octet-stream') return said;
  return MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export interface MoveOptions {
  /** An exact column name, for when a stage alone can't say which; it overrides the stage. */
  column?: string;
  /** A comment to leave with the move. */
  note?: string;
  /** Assign the story to whoever Orbit is signed in as. */
  assignToMe?: boolean;
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

/** A named column the story can't move to, with the ones it can. */
export function noSuchColumnError(name: string, columns: BoardColumn[]): TrackerMoveError {
  const list = columns.map((c) => `${c.name} (${c.stage})`).join(', ');
  return new TrackerMoveError(`No column "${name}" this story can move to. Its columns: ${list}`);
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
