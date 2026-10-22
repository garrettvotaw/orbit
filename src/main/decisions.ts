import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Decision } from '../shared/types.ts';
import { plainEnglishIssues } from '../shared/plain-english.ts';
import { RowTable, type Db } from './db.ts';
export { forProductOwner } from '../shared/po-text.ts';

/** How long a lane's own history (for list_product_questions) keeps answered questions. */
const HISTORY_MS = 3 * 24 * 60 * 60_000;

export interface NewDecision {
  laneId: string;
  laneName: string;
  question: string;
  today: string;
  proposed?: string | null;
  options?: string[];
  story?: string | null;
}

/** The decisions table, one row per question, field for field with `Decision`. */
export function decisionRows(db: Db): RowTable<Decision> {
  return new RowTable<Decision>(
    db,
    'decisions',
    [
      'id',
      'n',
      'laneId',
      'laneName',
      'question',
      'today',
      'proposed',
      'options',
      'story',
      'askedAt',
      'status',
      'answer',
      'answeredAt',
      'deliveredAt',
      'sentAt',
    ],
    { json: ['options'] },
  );
}

/**
 * Product questions the PMs raise, kept in Orbit's database so they survive restarts, fresh
 * starts, and the PM forgetting it asked.
 */
export class DecisionStore {
  #list: Decision[] = [];
  readonly #rows: RowTable<Decision>;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #listeners = new Set<(d: Decision | null) => void>();

  constructor(db: Db, opts: { now?: () => number; newId?: () => string } = {}) {
    this.#rows = decisionRows(db);
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? randomUUID;
    this.#list = this.#rows.all('n');
  }

  /** Called after every change with the question that just arrived, or null for other changes. */
  onChange(cb: (arrived: Decision | null) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /**
   * What still needs showing: open questions first, oldest first, then answers that have not
   * reached their lane yet. A delivered answer is done and leaves the list.
   */
  list(): Decision[] {
    return [...this.#list]
      .filter((d) => d.status === 'open' || d.deliveredAt === null)
      .sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open') || a.askedAt - b.askedAt);
  }

  /** Everything a lane has asked lately, answered or not, so it never asks the same thing twice. */
  history(laneId: string): Decision[] {
    const cutoff = this.#now() - HISTORY_MS;
    return this.#list
      .filter((d) => d.laneId === laneId && (d.status === 'open' || (d.answeredAt ?? 0) > cutoff))
      .sort((a, b) => a.askedAt - b.askedAt);
  }

  /** Answers that have not reached any lane yet. */
  waiting(): Decision[] {
    return this.#list.filter((d) => d.status === 'answered' && d.deliveredAt === null);
  }

  /** Hand a question to another lane, for an answer whose own lane is gone. */
  reassign(id: string, laneId: string, laneName: string): void {
    const d = this.get(id);
    if (!d || (d.laneId === laneId && d.laneName === laneName)) return;
    d.laneId = laneId;
    d.laneName = laneName;
    this.#save([d]);
  }

  get(id: string): Decision | undefined {
    return this.#list.find((d) => d.id === id);
  }

  open(laneId?: string): Decision[] {
    return this.#list.filter((d) => d.status === 'open' && (!laneId || d.laneId === laneId));
  }

  /** Record a question; the same words from the same lane while one is open return that one. */
  add(input: NewDecision): { decision: Decision; duplicate: boolean } {
    const key = norm(input.question);
    const existing = this.#list.find(
      (d) => d.laneId === input.laneId && d.status === 'open' && norm(d.question) === key,
    );
    if (existing) return { decision: existing, duplicate: true };
    const decision: Decision = {
      id: this.#newId(),
      n: this.#list.reduce((m, d) => Math.max(m, d.n), 0) + 1,
      laneId: input.laneId,
      laneName: input.laneName,
      question: input.question.trim(),
      today: input.today.trim(),
      proposed: input.proposed?.trim() || null,
      options: (input.options ?? []).map((o) => o.trim()).filter(Boolean),
      story: input.story?.trim() || null,
      askedAt: this.#now(),
      status: 'open',
      answer: null,
      answeredAt: null,
      deliveredAt: null,
      sentAt: null,
    };
    this.#list.push(decision);
    this.#save([decision], decision);
    return { decision, duplicate: false };
  }

  answer(id: string, answer: string): Decision | null {
    const d = this.get(id);
    if (!d || !answer.trim()) return null;
    d.answer = answer.trim();
    d.answeredAt = this.#now();
    d.status = 'answered';
    d.deliveredAt = null;
    this.#save([d]);
    return d;
  }

  /** Forget a question; the PM is told to use its own judgment if it is still running. */
  dismiss(id: string): Decision | null {
    const i = this.#list.findIndex((d) => d.id === id);
    if (i === -1) return null;
    const [d] = this.#list.splice(i, 1);
    this.#rows.remove([d.id]);
    this.#notify(null);
    return d;
  }

  markSent(ids: string[]): void {
    const at = this.#now();
    const sent = this.#list.filter((d) => ids.includes(d.id) && d.status === 'open');
    for (const d of sent) d.sentAt = at;
    this.#save(sent);
  }

  /** Answers the PM has not heard yet. */
  undelivered(laneId: string): Decision[] {
    return this.#list.filter((d) => d.laneId === laneId && d.status === 'answered' && d.deliveredAt === null);
  }

  markDelivered(ids: string[]): void {
    const at = this.#now();
    const delivered = this.#list.filter((d) => ids.includes(d.id));
    for (const d of delivered) d.deliveredAt = at;
    this.#save(delivered);
  }

  /** Put an answer back in the queue when the lane could not take it after all. */
  unmarkDelivered(ids: string[]): void {
    const back = this.#list.filter((d) => ids.includes(d.id));
    for (const d of back) d.deliveredAt = null;
    this.#save(back);
  }

  /** Write the questions that changed, then tell the listeners. */
  #save(changed: Decision[], arrived: Decision | null = null): void {
    this.#rows.put(changed);
    this.#notify(arrived);
  }

  #notify(arrived: Decision | null): void {
    for (const l of this.#listeners) l(arrived);
  }
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The message a PM receives when you answer. */
export function answerMessage(d: Decision): string {
  const story = d.story ? ` (story ${d.story})` : '';
  return `Product answer Q${d.n}${story}: ${d.answer}\nThe question was: ${d.question}`;
}

export interface AnswerTaker {
  isLive(laneId: string): boolean;
  send(laneId: string, text: string, priority: 'next'): boolean;
}

/**
 * Hand a running lane every answer it has not heard yet. Answers are marked delivered before
 * the send, because the host reports each send as a change and that change calls back here;
 * a send the lane cannot take goes back in the queue.
 */
export function deliverAnswers(store: DecisionStore, host: AnswerTaker, laneId: string): number {
  if (!host.isLive(laneId)) return 0;
  const due = store.undelivered(laneId);
  if (!due.length) return 0;
  store.markDelivered(due.map((d) => d.id));
  const refused = due.filter((d) => !host.send(laneId, answerMessage(d), 'next'));
  if (refused.length) store.unmarkDelivered(refused.map((d) => d.id));
  return due.length - refused.length;
}

/**
 * An answer whose lane is gone, or whose story moon has finished, goes to the moon's PM instead;
 * one with nowhere to go counts as delivered rather than waiting forever.
 */
export function rerouteAnswers(
  store: DecisionStore,
  host: { isLive(laneId: string): boolean; lane(laneId: string): { id: string; name: string } | undefined },
  storyOf: (laneId: string) => { parentId: string; finished: boolean } | null,
): void {
  for (const d of store.waiting()) {
    const lane = host.lane(d.laneId);
    const story = storyOf(d.laneId);
    const finished = story ? story.finished && !host.isLive(d.laneId) : false;
    if (lane && !finished) continue;
    const parent = story ? host.lane(story.parentId) : undefined;
    if (parent) store.reassign(d.id, parent.id, parent.name);
    else store.markDelivered([d.id]);
  }
}

/** The message a PM receives when you let a question go unanswered. */
export function withdrawnMessage(d: Decision): string {
  return `Q${d.n} was withdrawn: no product answer is coming. Go with your recommendation${
    d.options[0] ? ` (${d.options[0]})` : ''
  } and note the choice in your report.`;
}

/** Everything the tool refuses, as one message the PM can act on. */
export function toolRejection(parts: Array<[string, string[]]>): string {
  const lines = parts
    .filter(([, issues]) => issues.length)
    .map(([field, issues]) => `- ${field}: ${issues.join('; ')}`);
  return [
    'Not recorded. Rewrite it for the product owner, who is not a developer:',
    ...lines,
    '',
    'Say what the person using the app sees or does, not how the code works. Use the words the old app and the business use. One decision per question. Then call ask_product_owner again.',
  ].join('\n');
}

/** One in-process MCP server named `orbit`, so every tool reads as mcp__orbit__<name>. */
export function orbitServer(tools: unknown[]) {
  return createSdkMcpServer({
    name: 'orbit',
    version: '1.0.0',
    tools: tools as Parameters<typeof createSdkMcpServer>[0]['tools'],
  });
}

/** The product-question tools alone, as a server; what a PM session got before story moons. */
export function orbitTools(
  store: DecisionStore,
  lane: { id: string; name: string; story?: string | null },
  opts: DecisionToolOptions = {},
) {
  return orbitServer(decisionTools(store, lane, opts));
}

/**
 * The product-question tools: raise a question in plain English, and see the ones already open
 * so a lane never asks twice. Bound to one lane; a story moon's questions carry its story.
 */
/** Who reads Orbit, and the all-caps words a product question may use. */
export interface DecisionToolOptions {
  who?: string;
  productTerms?: string[];
}

export function decisionTools(
  store: DecisionStore,
  lane: { id: string; name: string; story?: string | null },
  opts: DecisionToolOptions = {},
) {
  const who = opts.who ?? 'the user';
  const terms = opts.productTerms ?? [];
  const ask = tool(
    'ask_product_owner',
    [
      'Raise a product question only the product owner can settle, in plain English a non-developer can answer in one line.',
      `Non-blocking: the question is recorded and shown to ${who}, who may pass it to the product owner. Keep working on everything that does not depend on the answer, and list the waiting story under Blocked in your report with its Q number.`,
      'The answer arrives later as a user message starting "Product answer Q<n>".',
      'Write for an 8th-grade reader: no code words, identifiers, field codes, or system names; say what the person using the app sees or does; name what the old app does today.',
    ].join(' '),
    {
      question: z.string().describe('One question, under 45 words, ending in a question mark.'),
      today: z.string().describe('What the old app does today, in one or two plain sentences.'),
      proposed: z.string().optional().describe('What the new app would do if you had to guess, in one plain sentence.'),
      options: z
        .array(z.string())
        .max(4)
        .optional()
        .describe('Two to four short choices, the one you recommend first.'),
      story: z
        .string()
        .optional()
        .describe('The story id, as its tracker writes it, that this decides, when there is one.'),
    },
    async (args) => {
      const issues: Array<[string, string[]]> = [
        ['question', plainEnglishIssues(args.question, 'question', terms)],
        ['today', plainEnglishIssues(args.today, 'note', terms)],
        ['proposed', args.proposed ? plainEnglishIssues(args.proposed, 'note', terms) : []],
        ...(args.options ?? []).map((o, i): [string, string[]] => [
          `option ${i + 1}`,
          plainEnglishIssues(o, 'option', terms),
        ]),
      ];
      if (issues.some(([, list]) => list.length)) {
        return { content: [{ type: 'text', text: toolRejection(issues) }], isError: true };
      }
      const { decision, duplicate } = store.add({
        laneId: lane.id,
        laneName: lane.name,
        ...args,
        story: args.story ?? lane.story ?? undefined,
      });
      const text = duplicate
        ? `Already asked as Q${decision.n} on ${new Date(decision.askedAt).toLocaleString()}; it is still open. Do not ask again. Keep working on what does not depend on it.`
        : `Recorded as Q${decision.n}. Do not wait on it: keep working on anything that does not depend on the answer, and list the waiting story under Blocked as "waiting on Q${decision.n}". The answer will arrive as a message starting "Product answer Q${decision.n}".`;
      return { content: [{ type: 'text', text }] };
    },
  );
  const list = tool(
    'list_product_questions',
    'The product questions this lane has raised: open ones to avoid asking twice, and answered ones with their answers.',
    {},
    async () => {
      const mine = store.history(lane.id);
      if (!mine.length) return { content: [{ type: 'text', text: 'No product questions on file for this lane.' }] };
      const lines = mine.map((d) =>
        d.status === 'open'
          ? `Q${d.n} (open${d.story ? `, story ${d.story}` : ''}): ${d.question}`
          : `Q${d.n} (answered${d.story ? `, story ${d.story}` : ''}): ${d.question} -> ${d.answer}`,
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
  return [ask, list];
}
