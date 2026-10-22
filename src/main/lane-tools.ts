import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { LaneKind, PmReport, ReviewPrompt } from '../shared/types.ts';

/** The longest status line a core can show without wrapping into a paragraph. */
export const STATUS_MAX = 100;
const OPTION_MAX = 70;

/** What a lane stopped for: one question for the user and the choices it laid out. */
export interface NeedsYou {
  question: string;
  options: string[];
  story: string | null;
}

/** Where the lane tools land: the host, which turns each call into lane state and attention. */
export interface LaneSink {
  needsYou(laneId: string, ask: NeedsYou): void;
  /** False when the lane had nothing open. */
  withdrawNeedsYou(laneId: string): boolean;
  postStatus(laneId: string, line: string): void;
  reportBoard(laneId: string, report: Omit<PmReport, 'at'>): void;
  reviewPreview(laneId: string, prompt: ReviewPrompt): void;
}

/**
 * What every lane but a chat is told on top of its own agent or skill, so a new agent uses the
 * tools without its own instructions mentioning Orbit. Null for a chat, which is just a conversation.
 */
export function laneRules(kind: LaneKind, who = 'the user'): string | null {
  if (kind === 'chat') return null;
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  return [
    '# Running in Orbit',
    `You are a lane in Orbit, ${who}'s desktop app. ${Who} reads Orbit, not your reply text: a question left in your reply never reaches them.`,
    `- When you need ${who} to decide or do something, call mcp__orbit__needs_you with one plain question and short choices. Keep working on what does not depend on it, then end your turn; their reply arrives as a message. If you settle it yourself first, call mcp__orbit__withdraw_needs_you.`,
    '- At the end of every turn, call mcp__orbit__post_status with one line, about 12 words, on what changed or where things stand.',
    ...(kind === 'review'
      ? [
          `- When the review reaches its preview of comments, or finds nothing to comment on, call mcp__orbit__review_preview with the numbered findings, each with the exact comment text to post, instead of asking in text, then end your turn. Orbit posts the review itself when ${who} picks a status; you hear back only if it could not, as one reply naming the comments to drop and the status, which you then post.`,
        ]
      : ['- A question only the product owner can answer goes to mcp__orbit__ask_product_owner, not needs_you.']),
    ...(kind === 'project'
      ? ['- At the end of every board run, call mcp__orbit__report_board with the board you derived.']
      : []),
  ].join('\n');
}

const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const refuse = (text: string) => ({ ...say(text), isError: true });

/** Why an ask can't go up as written, one line per problem; empty when it can. */
function askIssues(question: string, options: string[]): string[] {
  const issues: string[] = [];
  if (!question) issues.push('question: empty');
  options.forEach((o, i) => {
    if (!o) issues.push(`option ${i + 1}: empty`);
    else if (o.length > OPTION_MAX) issues.push(`option ${i + 1}: over ${OPTION_MAX} characters; it becomes a button`);
  });
  return issues;
}

/**
 * The tools every lane but a chat gets: stop for the user's word without stopping work, take the
 * ask back, and say where things stand in one line. Bound to one lane; a moon's asks carry its story.
 */
export function laneTools(sink: LaneSink, lane: { id: string; story?: string | null }, who = 'the user') {
  const needsYou = tool(
    'needs_you',
    [
      `Ask ${who} for a call only they can make: a merge, a process or technical choice, something you are not allowed to do. This is the only way your core turns amber and says "your turn"; a question left in your reply text does not reach them.`,
      'Non-blocking: keep working on everything that does not depend on the answer, then end your turn. Their reply arrives as a user message.',
      'One open ask per lane; calling again replaces it. Product questions go to ask_product_owner instead.',
    ].join(' '),
    {
      question: z.string().describe('One plain question, as you would ask it in Teams.'),
      options: z
        .array(z.string())
        .max(6)
        .optional()
        .describe('Up to six short choices, recommended first. Each becomes a button that sends its own text.'),
      story: z.string().optional().describe('The story it is about, as its tracker writes it, when there is one.'),
    },
    async (args) => {
      const question = args.question.trim();
      const options = (args.options ?? []).map((o) => o.trim());
      const issues = askIssues(question, options);
      if (issues.length) return refuse(['Not raised:', ...issues.map((i) => `- ${i}`)].join('\n'));
      sink.needsYou(lane.id, { question, options, story: args.story ?? lane.story ?? null });
      return say(
        `Shown to ${who}. Do not wait on it: keep working on anything that does not depend on the answer, then end your turn. Their reply arrives as a user message. If you settle it yourself first, call withdraw_needs_you.`,
      );
    },
  );
  const withdraw = tool(
    'withdraw_needs_you',
    `Take back your open needs_you ask once it no longer needs ${who}, so your core stops saying "your turn".`,
    {},
    async () => say(sink.withdrawNeedsYou(lane.id) ? 'Withdrawn.' : 'Nothing was open; nothing to withdraw.'),
  );
  const status = tool(
    'post_status',
    `Set the one line shown under your core, like a Teams status: what changed or where things stand, about 12 words. Call it at the end of every turn. It never asks ${who} anything; use needs_you for that.`,
    { line: z.string().describe(`One line, ${STATUS_MAX} characters at most.`) },
    async (args) => {
      const line = args.line.trim();
      if (!line || /\r|\n/.test(line)) return refuse('Not posted: send one line of text.');
      if (line.length > STATUS_MAX)
        return refuse(`Not posted: ${line.length} characters; keep it under ${STATUS_MAX}, about 12 words.`);
      sink.postStatus(lane.id, line);
      return say('Posted.');
    },
  );
  return [needsYou, withdraw, status];
}

const items = (what: string) =>
  z.array(z.string()).optional().describe(`${what}, one per story: its number and a few words on what it does.`);

/** The PM's board at the end of a run, as the strip under its core shows it. */
export function boardTool(sink: LaneSink, lane: { id: string }) {
  return tool(
    'report_board',
    'Send Orbit the board you just derived, at the end of every board run. Orbit draws the counts under your core and refreshes the board ring from it. Your reply text stays the short Teams-style update.',
    {
      shipped: items('Stories that reached a PR or merged this run'),
      inFlight: items('Stories being built right now'),
      consults: items('Stories still in consults or planning'),
      drift: items('Stories whose tracker column is out of step with their PR'),
      blocked: items('Stories waiting on someone, like "100205 waiting on Q19"'),
      next: z.string().optional().describe('The story you would start next, if any.'),
    },
    async (args) => {
      sink.reportBoard(lane.id, {
        shipped: args.shipped ?? [],
        inFlight: args.inFlight ?? [],
        consults: args.consults ?? [],
        drift: args.drift ?? [],
        blocked: args.blocked ?? [],
        next: args.next ?? null,
      });
      return say('Board recorded.');
    },
  );
}

/** The review-pr skill's preview, so the panel can offer keep/drop per comment and a status. */
export function reviewTool(sink: LaneSink, lane: { id: string }, who = 'the user') {
  return tool(
    'review_preview',
    `Show ${who} the comments you propose to post, numbered as in your preview, with the exact text of each, then end your turn. Send an empty list for a clean PR. They drop comments and pick approve, request changes, or comment only in Orbit, and Orbit posts the review to GitHub itself; do not post it, and do not ask for the status separately. If Orbit cannot post it, their reply names the comments to drop and the status, and you post it as the skill says.`,
    {
      findings: z.array(
        z.object({
          n: z.number().int().describe('The number the comment has in your preview.'),
          severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
          file: z.string().describe('Path from the repo root.'),
          line: z.number().int().describe('The line in the file at the PR head, as the review API takes it.'),
          gist: z.string().describe('The first sentence of the comment.'),
          body: z.string().describe('The whole comment, exactly as it should appear on GitHub.'),
        }),
      ),
    },
    async (args) => {
      sink.reviewPreview(lane.id, { findings: args.findings });
      return say(
        `Shown to ${who}. End your turn now; Orbit posts the review when they pick a status, and you hear back only if it could not.`,
      );
    },
  );
}
