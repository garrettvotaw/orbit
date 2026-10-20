import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  ORBIT_STAGES,
  type LaneConfig,
  type OrbitConfig,
  type OrbitStage,
  type TrackerBoard,
  type TrackerItem,
} from '../shared/types.ts';
import type { StoryDetail, Tracker } from './trackers/tracker.ts';

/** What the board tools reach: a project's tracker, its last polled board, and a way to poll again. */
export interface BoardAccess {
  tracker(projectId: string): Tracker | null;
  board(projectId: string): TrackerBoard | null;
  refresh(projectId: string): Promise<void>;
}

const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const refuse = (text: string) => ({ ...say(text), isError: true });
const stage = z.enum(ORBIT_STAGES as [OrbitStage, ...OrbitStage[]]);
const STAGES = ORBIT_STAGES.join(', ');

function line(i: TrackerItem): string {
  const prs = i.prs.length ? `PRs ${i.prs.map((p) => `#${p.number}`).join(', ')}` : 'no PRs';
  return `${i.key} · ${i.stage} (${i.column}) · ${i.title} · ${i.assignedTo ?? 'unassigned'} · ${prs}`;
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
    '',
    `Comments:\n${list(d.comments.map((c) => `- ${c.author} (${day(c.at)}): ${c.text}`))}`,
    '',
    `Children:\n${list(d.children.map((c) => `- ${c.key} · ${c.stage} (${c.column}) · ${c.title}`))}`,
    '',
    `Links:\n${list(d.links.map((l) => `- ${l.title}: ${l.url}`))}`,
  ].join('\n');
}

/**
 * The four board tools for one project. They speak Orbit's stages whatever the tracker is, and
 * Orbit turns each call into the right tracker call; nothing else in Orbit writes to a tracker.
 */
export function boardTools(access: BoardAccess, lane: { projectId: string }): unknown[] {
  const { projectId } = lane;
  const keyOf = (id: string) => access.board(projectId)?.items.find((i) => i.id === id)?.key ?? id;
  const guard = async (fn: (t: Tracker) => Promise<ReturnType<typeof say>>) => {
    const t = access.tracker(projectId);
    if (!t) return refuse('This project has no tracker.');
    try {
      return await fn(t);
    } catch (e) {
      return refuse((e as Error).message);
    }
  };
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
    tool(
      'move_story',
      `Move a story to a stage (${STAGES}); Orbit picks the tracker column for it. An optional note is posted as a comment.`,
      {
        id: z.string().describe('The story id as its tracker writes it.'),
        stage: stage.describe('Where the story is now.'),
        note: z.string().optional().describe('A comment to leave with the move.'),
      },
      async (args) =>
        guard(async (t) => {
          const column = await t.move(args.id, args.stage, args.note);
          await access.refresh(projectId);
          return say(`Moved ${keyOf(args.id)} to ${column.name} (${args.stage}).`);
        }),
    ),
    tool(
      'comment_on_story',
      'Leave a comment on a story in your tracker.',
      { id: z.string().describe('The story id as its tracker writes it.'), text: z.string().min(1) },
      async (args) =>
        guard(async (t) => {
          await t.comment(args.id, args.text);
          return say(`Commented on ${keyOf(args.id)}.`);
        }),
    ),
  ];
}

/**
 * The board tools a lane gets: a PM for its own project, a story moon for its PM's, and nobody
 * else; none at all when the project has no tracker or `boardTools` is off.
 */
export function boardToolsFor(
  cfg: LaneConfig,
  config: OrbitConfig,
  access: BoardAccess,
  parentOf: (storyLaneId: string) => string | null,
): unknown[] {
  if (config.boardTools === false) return [];
  const projectId = cfg.kind === 'project' ? cfg.id : cfg.kind === 'story' ? parentOf(cfg.id) : null;
  if (!projectId || !access.tracker(projectId)) return [];
  return boardTools(access, { projectId });
}
