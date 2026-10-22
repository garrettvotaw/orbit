import { tool } from '@anthropic-ai/claude-agent-sdk';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import {
  ORBIT_STAGES,
  type LaneConfig,
  type OrbitConfig,
  type OrbitStage,
  type TrackerBoard,
  type TrackerItem,
} from '../shared/types.ts';
import {
  MAX_ATTACHMENT_READ,
  type LinkKind,
  type StoryDetail,
  type StoryFile,
  type Tracker,
} from './trackers/tracker.ts';

/** What the board tools reach: a project's tracker, its last polled board, and a way to poll again. */
export interface BoardAccess {
  tracker(projectId: string): Tracker | null;
  board(projectId: string): TrackerBoard | null;
  refresh(projectId: string): Promise<void>;
}

type Reply = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
};

const say = (text: string): Reply => ({ content: [{ type: 'text', text }] });
const refuse = (text: string): Reply => ({ ...say(text), isError: true });
const stage = z.enum(ORBIT_STAGES as [OrbitStage, ...OrbitStage[]]);
const STAGES = ORBIT_STAGES.join(', ');

function line(i: TrackerItem): string {
  const prs = i.prs.length ? `PRs ${i.prs.map((p) => `#${p.number}`).join(', ')}` : 'no PRs';
  return `${i.key} · ${i.stage} (${i.column}) · ${i.title} · ${i.assignedTo ?? 'unassigned'} · ${prs}`;
}

const short = (i: TrackerItem) => `${i.key} · ${i.stage} (${i.column}) · ${i.title}`;

/** The parts a story may not have; each is left out rather than printed empty. */
function extras(d: StoryDetail): string[] {
  const section = (heading: string, body: string | null) => (body ? ['', `${heading}:\n${body}`] : []);
  const rows = (lines: string[]) => (lines.length ? lines.join('\n') : null);
  const parent = d.parent && `${short(d.parent.item)}\n${d.parent.acceptance ?? d.parent.description}`.trim();
  return [
    ...section('Repro steps', d.reproSteps),
    ...section('Parent', parent),
    ...section('Related', rows(d.related.map((r) => `- ${r.kind} ${short(r.item)}`))),
    ...section('Attachments', rows(d.attachments.map((a) => `- ${a.name}`))),
  ];
}

function storyText(d: StoryDetail): string {
  const day = (at: number) => (at ? new Date(at).toISOString().slice(0, 10) : 'undated');
  const list = (rows: string[]) => (rows.length ? rows.join('\n') : 'none');
  return [
    `${d.item.key} · ${d.item.title}`,
    `${d.item.stage} (${d.item.column}) · ${d.item.url}`,
    '',
    `Description:\n${d.description || 'none'}`,
    ...(d.acceptance ? ['', `Acceptance criteria:\n${d.acceptance}`] : []),
    ...extras(d),
    '',
    `Comments:\n${list(d.comments.map((c) => `- ${c.author} (${day(c.at)}): ${c.text}`))}`,
    '',
    `Children:\n${list(d.children.map((c) => `- ${short(c)}`))}`,
    '',
    `Links:\n${list(d.links.map((l) => `- ${l.title}: ${l.url}`))}`,
  ].join('\n');
}

/** The image types a model can look at; past 5 MB, which is all Orbit reads of a file, it can't take them either. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_TYPES = /^text\/|^application\/(json|xml)$|\+(json|xml)$/;
/** As much text as one tool result carries without running past the CLI's MCP output limit. */
const TEXT_SHOWN_BYTES = 64 * 1024;
const LINK_VERB: Record<LinkKind, string> = { duplicate: 'duplicates', related: 'relates to', blocks: 'blocks' };

/**
 * An attachment as the agent gets it: an image it can see, text it can read (the first 64 KB of a
 * long one, saying so), or a line saying what it is.
 */
function fileReply(f: StoryFile): Reply {
  const whole = f.size === f.data.length;
  const size = f.size === null ? `over ${MAX_ATTACHMENT_READ / (1024 * 1024)} MB` : `${f.size} bytes`;
  if (IMAGE_TYPES.has(f.mimeType) && whole) {
    return { content: [{ type: 'image', data: Buffer.from(f.data).toString('base64'), mimeType: f.mimeType }] };
  }
  if (TEXT_TYPES.test(f.mimeType)) {
    const text = new TextDecoder().decode(f.data.subarray(0, TEXT_SHOWN_BYTES));
    if (whole && f.data.length <= TEXT_SHOWN_BYTES) return say(text);
    return say(`${text}\n\n[Orbit showed the first 64 KB of ${f.name}, which is ${size}.]`);
  }
  return say(`${f.name} is ${f.mimeType}, ${size}; Orbit can't show it here.`);
}

/**
 * The board tools for one project. They speak Orbit's stages whatever the tracker is, and
 * Orbit turns each call into the right tracker call; nothing else in Orbit writes to a tracker.
 */
export function boardTools(access: BoardAccess, lane: { projectId: string; cwd?: string }): unknown[] {
  const { projectId } = lane;
  const ctx: ToolContext = {
    access,
    projectId,
    cwd: lane.cwd ?? process.cwd(),
    keyOf: (id) => access.board(projectId)?.items.find((i) => i.id === id)?.key ?? id,
    guard: async (fn) => {
      const t = access.tracker(projectId);
      if (!t) return refuse('This project has no tracker.');
      try {
        return await fn(t);
      } catch (e) {
        return refuse((e as Error).message);
      }
    },
  };
  return [...readTools(ctx), ...fileTools(ctx), ...writeTools(ctx)];
}

/**
 * What every board tool shares: its project, the lane's folder, a story's key for replies, and a
 * guard that turns a failure into an error reply.
 */
interface ToolContext {
  access: BoardAccess;
  projectId: string;
  cwd: string;
  keyOf(id: string): string;
  guard(fn: (t: Tracker) => Promise<Reply>): Promise<Reply>;
}

/** The tools that only read: the board and a story. */
function readTools({ access, projectId, guard }: ToolContext): unknown[] {
  return [
    tool(
      'list_board',
      `Your board's stories as Orbit last read them: key, stage (one of ${STAGES}), the tracker's own column, title, assignee, and linked PRs. Optionally only one stage.`,
      { stage: stage.optional().describe('Only stories at this stage.') },
      async (args) => {
        const b = access.board(projectId);
        if (!b) return say('The board has not loaded yet.');
        const items = b.items.filter((i) => !args.stage || i.stage === args.stage);
        return say(
          items.length
            ? items.map(line).join('\n')
            : `No stories on the board${args.stage ? ` at ${args.stage}` : ''}.`,
        );
      },
    ),
    tool(
      'get_story',
      'One story in full from your tracker: description, acceptance criteria, comments, children, and links.',
      { id: z.string().describe('The story id as its tracker writes it: 100204, ACME-123, or 45.') },
      async (args) => guard(async (t) => say(storyText(await t.story(args.id)))),
    ),
  ];
}

/** The tools for a story's files: reading one it has, and attaching one from disk. */
function fileTools({ cwd, keyOf, guard }: ToolContext): unknown[] {
  return [
    tool(
      'get_attachment',
      "One of a story's attachments by the name get_story lists: an image you can see, text you can read, or what kind of file it is.",
      {
        id: z.string().describe('The story id as its tracker writes it.'),
        name: z.string().describe('The file name, exactly as get_story lists it.'),
      },
      async (args) => guard(async (t) => fileReply(await t.attachment(args.id, args.name))),
    ),
    tool(
      'attach_to_story',
      'Attach a file from disk to a story in your tracker, like a screenshot or a log. Up to 20 MB.',
      {
        id: z.string().describe('The story id as its tracker writes it.'),
        path: z.string().describe(`The file's path; a relative one is taken from ${cwd}.`),
      },
      async (args) =>
        guard(async (t) => {
          const saved = await t.attach(args.id, await attachable(resolve(cwd, args.path)));
          return say(`Attached ${saved.name} to ${keyOf(args.id)}.`);
        }),
    ),
  ];
}

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

/** A file to attach, refused before anything is sent when it's missing, a folder, or over 20 MB. */
async function attachable(path: string): Promise<{ name: string; data: Uint8Array }> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`No file at ${path}.`);
  if (info.isDirectory()) throw new Error(`${path} is a folder, not a file.`);
  const name = basename(path);
  if (info.size > MAX_ATTACH_BYTES) {
    throw new Error(`${name} is over 20 MB (${info.size} bytes); link it in a comment instead.`);
  }
  return { name, data: new Uint8Array(await readFile(path)) };
}

/** The tools that change the tracker: a move, a comment, and a link. */
function writeTools({ access, projectId, keyOf, guard }: ToolContext): unknown[] {
  return [
    tool(
      'move_story',
      `Move a story to a stage (${STAGES}); Orbit picks the tracker column for it. An optional note is posted as a comment.`,
      {
        id: z.string().describe('The story id as its tracker writes it.'),
        stage: stage.describe('Where the story is now.'),
        column: z
          .string()
          .optional()
          .describe(
            "An exact column name, for when a stage alone can't say which, like a review column after testing. It overrides stage.",
          ),
        note: z.string().optional().describe('A comment to leave with the move.'),
        assignToMe: z.boolean().optional().describe('Also assign the story to whoever Orbit is signed in as.'),
      },
      async (args) =>
        guard(async (t) => {
          const opts = { column: args.column, note: args.note, assignToMe: args.assignToMe };
          const column = await t.move(args.id, args.stage, opts);
          await access.refresh(projectId);
          return say(`Moved ${keyOf(args.id)} to ${column.name} (${column.stage}).`);
        }),
    ),
    tool(
      'comment_on_story',
      'Leave a comment on a story in your tracker. With a marker, Orbit edits the comment it left before with that marker instead of adding another, so one plan or status comment stays current.',
      {
        id: z.string().describe('The story id as its tracker writes it.'),
        text: z.string().min(1),
        marker: z
          .string()
          .regex(/^[\w.-]{1,64}$/)
          .optional()
          .describe('A name for the comment to keep up to date, like plan or status.'),
      },
      async (args) =>
        guard(async (t) => {
          const result = await t.comment(args.id, args.text, args.marker ? { marker: args.marker } : undefined);
          const key = keyOf(args.id);
          if (result === 'updated') return say(`Updated the ${args.marker} comment on ${key}.`);
          if (result === 'unmarked')
            return say(
              `Commented on ${key}, but the tracker dropped the hidden "${args.marker}" marker, so the next "${args.marker}" comment will be a new one.`,
            );
          return say(`Commented on ${key}.`);
        }),
    ),
    tool(
      'link_stories',
      'Link two stories in your tracker, read from the first: duplicate means it duplicates the other, blocks that it blocks the other, related that they relate.',
      {
        id: z.string().describe('The story the link reads from, as its tracker writes it.'),
        otherId: z.string().describe('The story it points at.'),
        kind: z.enum(['duplicate', 'related', 'blocks']),
      },
      async (args) =>
        guard(async (t) => {
          await t.link(args.id, args.otherId, args.kind);
          const [key, other] = [keyOf(args.id), keyOf(args.otherId)];
          const linked = `Linked ${key} ${LINK_VERB[args.kind]} ${other}.`;
          if (t.ref?.kind !== 'github') return say(linked);
          const how =
            args.kind === 'duplicate'
              ? `a "Duplicate of ${other}" comment on ${key}, and ${key} is closed as a duplicate`
              : `a comment on ${key} naming ${other}, which shows as a cross-reference`;
          return say(`${linked} On GitHub that is ${how}.`);
        }),
    ),
  ];
}

/**
 * The board tools a lane gets: a PM for its own project, a story moon for its PM's, a chat for
 * the project it names, and nobody else; none at all when the project has no tracker or
 * `boardTools` is off.
 */
export function boardToolsFor(
  cfg: LaneConfig,
  config: OrbitConfig,
  access: BoardAccess,
  parentOf: (storyLaneId: string) => string | null,
): unknown[] {
  if (config.boardTools === false) return [];
  const projectId =
    cfg.kind === 'project'
      ? cfg.id
      : cfg.kind === 'story'
        ? parentOf(cfg.id)
        : cfg.kind === 'chat'
          ? (cfg.project ?? null)
          : null;
  if (!projectId || !access.tracker(projectId)) return [];
  return boardTools(access, { projectId, cwd: cfg.cwd });
}
