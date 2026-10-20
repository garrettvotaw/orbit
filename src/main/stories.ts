import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  STORY_DONE,
  STORY_RESTING,
  type Decision,
  type LaneStatus,
  type StoryConfig,
  type StoryInfo,
  type StoryStage,
} from '../shared/types.ts';
import { RowTable, tx, type Db } from './db.ts';
import { answerMessage } from './decisions.ts';

/** One story on a moon, as the stories table keeps it. */
export interface StoryRecord {
  id: string;
  parentId: string;
  parentName: string;
  storyId: string;
  title: string;
  brief: string;
  cwd: string;
  agent: string;
  model: string | null;
  stage: StoryStage;
  pr: number | null;
  prUrl: string | null;
  files: string[];
  /** While waiting: the stories holding files this one asked for. */
  waitingOn: string[];
  /** While waiting: the files Orbit claims for it when it wakes, on top of `files`. */
  waitingFiles: string[];
  summary: string | null;
  worktree: string | null;
  branch: string | null;
  startedAt: number;
  updatedAt: number;
  /** Every report the moon has made, oldest first. */
  reports: Array<{ at: number; stage: StoryStage; summary: string }>;
}

/** A report waiting for its PM to be between turns. */
export interface Mail {
  laneId: string;
  text: string;
  at: number;
}

export const STORY_AGENT = 'story-manager';
export const STORY_WIP_CAP = 2;
/** The most a story moon runs on. */
export const STORY_MODEL_CAP = 'claude-opus-5-5';

/**
 * A moon's model, with Fable brought down to Opus in the same form: the alias stays an alias, and a
 * Bedrock or API id keeps its prefix. Null stays null and means the CLI default.
 */
export function capStoryModel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (!/fable/i.test(model)) return model;
  if (/^fable$/i.test(model.trim())) return 'opus';
  return model.replace(/claude-fable[^[\s]*(\[[^\]]*\])?/i, STORY_MODEL_CAP);
}
/** How long a moon stays on the stage after its PR opens before it leaves by itself. */
export const STORY_RETENTION_MS = 3 * 60_000;

export function storyLaneId(parentId: string, storyId: string): string {
  return `story-${parentId}-${storyId}`;
}

/** The report stages a moon may send; 'building' is implied by a planned report. */
const REPORT_STAGES = ['planned', 'pr-opened', 'blocked', 'failed'] as const;

/** The stories table, one row per moon, field for field with `StoryRecord`. */
export function storyRows(db: Db): RowTable<StoryRecord> {
  return new RowTable<StoryRecord>(
    db,
    'stories',
    [
      'id',
      'parentId',
      'parentName',
      'storyId',
      'title',
      'brief',
      'cwd',
      'agent',
      'model',
      'stage',
      'pr',
      'prUrl',
      'files',
      'waitingOn',
      'waitingFiles',
      'summary',
      'worktree',
      'branch',
      'startedAt',
      'updatedAt',
      'reports',
    ],
    { json: ['files', 'waitingOn', 'waitingFiles', 'reports'] },
  );
}

/** The mail table: reports waiting for their PM, oldest first. */
export function mailRows(db: Db) {
  const insert = db.prepare('INSERT INTO mail (lane_id, text, at) VALUES (?, ?, ?)');
  const forLane = db.prepare('DELETE FROM mail WHERE lane_id = ?');
  return {
    all: (): Mail[] =>
      (
        db.prepare('SELECT lane_id, text, at FROM mail ORDER BY at, id').all() as Array<{
          lane_id: string;
          text: string;
          at: number;
        }>
      ).map((m) => ({ laneId: m.lane_id, text: m.text, at: m.at })),
    add: (mail: Mail[]) => tx(db, () => mail.forEach((m) => insert.run(m.laneId, m.text, m.at))),
    clear: (laneId: string) => forLane.run(laneId),
    count: () => (db.prepare('SELECT count(*) AS n FROM mail').get() as { n: number }).n,
  };
}

/**
 * Stories the PMs have handed to moons, kept in Orbit's database so a moon survives an Orbit
 * restart with its session, its claimed files, and the reports it has made.
 */
export class StoryStore {
  #list: StoryRecord[] = [];
  #mail: Mail[] = [];
  readonly #rows: RowTable<StoryRecord>;
  readonly #mailRows: ReturnType<typeof mailRows>;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();

  constructor(db: Db, opts: { now?: () => number } = {}) {
    this.#rows = storyRows(db);
    this.#mailRows = mailRows(db);
    this.#now = opts.now ?? Date.now;
    this.#list = this.#rows.all('startedAt');
    this.#mail = this.#mailRows.all();
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  list(): StoryRecord[] {
    return [...this.#list];
  }

  get(id: string): StoryRecord | undefined {
    return this.#list.find((s) => s.id === id);
  }

  forParent(parentId: string): StoryRecord[] {
    return this.#list.filter((s) => s.parentId === parentId);
  }

  /** Stories a PM still has in flight: anything that has not reported an end stage. */
  inFlight(parentId: string): StoryRecord[] {
    return this.forParent(parentId).filter((s) => !STORY_DONE.includes(s.stage));
  }

  add(
    input: Omit<
      StoryRecord,
      | 'stage'
      | 'pr'
      | 'prUrl'
      | 'files'
      | 'waitingOn'
      | 'waitingFiles'
      | 'summary'
      | 'worktree'
      | 'branch'
      | 'startedAt'
      | 'updatedAt'
      | 'reports'
    >,
  ): StoryRecord {
    const now = this.#now();
    const rec: StoryRecord = {
      ...input,
      stage: 'starting',
      pr: null,
      prUrl: null,
      files: [],
      waitingOn: [],
      waitingFiles: [],
      summary: null,
      worktree: null,
      branch: null,
      startedAt: now,
      updatedAt: now,
      reports: [],
    };
    this.#list = [...this.#list.filter((s) => s.id !== rec.id), rec];
    this.#rows.put([rec]);
    this.#notify();
    return rec;
  }

  update(id: string, patch: Partial<Omit<StoryRecord, 'id'>>): StoryRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    const next = { ...rec, ...patch, updatedAt: this.#now() };
    this.#list = this.#list.map((s) => (s.id === id ? next : s));
    this.#rows.put([next]);
    this.#notify();
    return next;
  }

  remove(id: string): boolean {
    const before = this.#list.length;
    this.#list = this.#list.filter((s) => s.id !== id);
    if (this.#list.length === before) return false;
    this.#rows.remove([id]);
    this.#notify();
    return true;
  }

  /** Files held by the other stories still in flight that overlap these. */
  conflicts(id: string, files: string[]): Array<{ storyId: string; files: string[] }> {
    const mine = this.get(id);
    const wanted = new Set(files.map(normalizePath));
    const out: Array<{ storyId: string; files: string[] }> = [];
    for (const other of this.#list) {
      if (other.id === id || STORY_DONE.includes(other.stage)) continue;
      if (mine && other.parentId !== mine.parentId) continue;
      const held = other.files.filter((f) => wanted.has(normalizePath(f)));
      if (held.length) out.push({ storyId: other.storyId, files: held });
    }
    return out;
  }

  /**
   * Park a story whose claim another story refused: it waits on the holders and keeps the files it
   * holds, unless one of the holders is itself waiting on it (directly or down a chain). Then it
   * lets go of its own files too, to be claimed back when it wakes, so two stories never wait on
   * each other forever. Returns the record and the holders that closed a loop.
   */
  park(id: string, wanted: string[], holders: string[]): { rec: StoryRecord; loop: string[] } | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    const loop = holders.filter((h) => this.#waitsOn(rec.parentId, h, rec.storyId));
    const yields = loop.length > 0;
    const next = this.update(id, {
      stage: 'waiting',
      waitingOn: holders,
      waitingFiles: unique([...rec.waitingFiles, ...wanted, ...(yields ? rec.files : [])]),
      files: yields ? [] : rec.files,
    })!;
    return { rec: next, loop };
  }

  /** Whether story `from`, or a story it waits on in turn, is waiting on story `target`. */
  #waitsOn(parentId: string, from: string, target: string): boolean {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const storyId = queue.pop()!;
      if (seen.has(storyId)) continue;
      seen.add(storyId);
      const rec = this.get(storyLaneId(parentId, storyId));
      if (rec?.stage !== 'waiting') continue;
      if (rec.waitingOn.includes(target)) return true;
      queue.push(...rec.waitingOn);
    }
    return false;
  }

  /** Queue a message for a lane; it goes when the lane is between turns. */
  post(laneId: string, text: string): void {
    const mail = { laneId, text, at: this.#now() };
    this.#mail = [...this.#mail, mail];
    this.#mailRows.add([mail]);
    this.#notify();
  }

  pending(laneId: string): Mail[] {
    return this.#mail.filter((m) => m.laneId === laneId);
  }

  take(laneId: string): Mail[] {
    const mine = this.pending(laneId);
    if (mine.length) {
      this.#mail = this.#mail.filter((m) => m.laneId !== laneId);
      this.#mailRows.clear(laneId);
      this.#notify();
    }
    return mine;
  }

  putBack(mail: Mail[]): void {
    if (!mail.length) return;
    this.#mail = [...mail, ...this.#mail].sort((a, b) => a.at - b.at);
    this.#mailRows.add(mail);
    this.#notify();
  }

  #notify(): void {
    for (const cb of this.#listeners) cb();
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
}

export function storyConfig(rec: StoryRecord): StoryConfig & { kind: 'story' } {
  const model = capStoryModel(rec.model);
  return {
    kind: 'story',
    id: rec.id,
    name: `${rec.storyId} · ${rec.title}`,
    cwd: rec.cwd,
    parentId: rec.parentId,
    storyId: rec.storyId,
    title: rec.title,
    brief: rec.brief,
    agent: rec.agent,
    ...(model ? { model } : {}),
  };
}

export function storyInfo(rec: StoryRecord): StoryInfo {
  return {
    storyId: rec.storyId,
    title: rec.title,
    stage: rec.stage,
    pr: rec.pr,
    prUrl: rec.prUrl,
    files: rec.files,
    waitingOn: rec.waitingOn,
    summary: rec.summary,
    worktree: rec.worktree,
    branch: rec.branch,
  };
}

/** The first message a story moon receives: who it is, what it owns, and the PM's brief. */
export function storyKickoff(input: { storyId: string; title: string; parentName: string; brief: string }): string {
  return [
    `You are the story manager for ADO story ${input.storyId}: ${input.title}.`,
    `You were started by the ${input.parentName} PM, which is only scheduling; you own this story from worktree to pull request. Run the story-engine skill.`,
    'Report to the PM with report_to_pm at these points and no others: planned (after your consults, with the files you claimed), pr-opened, blocked, or failed. After pr-opened, blocked, or failed you are done: end your turn.',
    'Before any lane edits a file, claim the files with claim_files; if another story holds one, Orbit parks this story until it lets go: end your turn, and carry on when Orbit says the files are yours.',
    'Product questions go through ask_product_owner, tagged with this story.',
    '',
    "The PM's brief:",
    input.brief.trim(),
  ].join('\n');
}

/** The message a PM receives when one of its stories reports. */
export function reportMessage(rec: StoryRecord, stage: StoryStage, summary: string): string {
  const head = `Story report ${rec.storyId} (${stage}): ${rec.title}`;
  const lines = [head, summary.trim()];
  if (stage === 'pr-opened' && rec.pr)
    lines.push(
      `PR #${rec.pr}${rec.prUrl ? ` ${rec.prUrl}` : ''}. The story's moon is done; the monitor owns the PR from here.`,
    );
  if (stage === 'planned' && rec.files.length) lines.push(`Files claimed: ${rec.files.join(', ')}`);
  if (stage === 'blocked')
    lines.push('Decide whether to answer it or let the story wait; start it again with start_story when it can go.');
  if (stage === 'failed') lines.push('Read its transcript before starting it again.');
  return lines.join('\n');
}

export interface MoonHost {
  isLive(laneId: string): boolean;
  lane(laneId: string): { status: LaneStatus; sessionId: string | null } | undefined;
  send(laneId: string, text: string, priority: 'next'): boolean;
  addTransient(cfg: StoryConfig & { kind: 'story' }): boolean;
  removeTransient(laneId: string): boolean;
  start(laneId: string): void;
  resume(laneId: string, sessionId: string): void;
  stop(laneId: string): Promise<void>;
  /** Whether the moon's start is waiting for memory; Orbit starts it by itself once there is room. */
  held?(laneId: string): boolean;
}

/**
 * Take a finished or waiting story's moon off the stage: stop its session if one is open, then
 * forget the lane and its record. Refused while the story is still at work.
 */
export async function dismissStory(
  store: StoryStore,
  host: Pick<MoonHost, 'isLive' | 'stop' | 'removeTransient'>,
  id: string,
): Promise<boolean> {
  const rec = store.get(id);
  if (!rec || !STORY_RESTING.includes(rec.stage)) return false;
  if (host.isLive(id)) await host.stop(id);
  if (!host.removeTransient(id)) return false;
  return store.remove(id);
}

/**
 * Dismiss every moon whose PR opened at least `ms` ago and that is not mid-turn. Blocked and
 * failed moons stay until you dismiss them. Returns the lanes that left.
 */
export async function sweepStories(
  store: StoryStore,
  host: Pick<MoonHost, 'isLive' | 'lane' | 'stop' | 'removeTransient'>,
  now: number,
  ms: number,
): Promise<string[]> {
  const resting: LaneStatus[] = ['idle', 'stopped', 'error'];
  const due = store
    .list()
    .filter((s) => s.stage === 'pr-opened' && now - s.updatedAt >= ms)
    .filter((s) => resting.includes(host.lane(s.id)?.status ?? 'stopped'));
  const left = await Promise.all(due.map((s) => dismissStory(store, host, s.id)));
  return due.filter((_, i) => left[i]).map((s) => s.id);
}

/**
 * Hand a PM every report waiting for it. Mail is taken before the send because the host reports
 * each send as a change and that change calls back here; a send the lane cannot take goes back.
 */
export function deliverMail(store: StoryStore, host: Pick<MoonHost, 'isLive' | 'send'>, laneId: string): number {
  if (!host.isLive(laneId)) return 0;
  const due = store.take(laneId);
  if (!due.length) return 0;
  const refused = due.filter((m) => !host.send(laneId, m.text, 'next'));
  store.putBack(refused);
  return due.length - refused.length;
}

/**
 * Pass an answer to a PM's question on to the moon running the story it was tagged with, so the
 * PM never has to relay it. A finished story's moon is left alone; its PM has the answer.
 */
export function forwardAnswer(store: StoryStore, host: Pick<MoonHost, 'isLive' | 'send'>, d: Decision): boolean {
  if (!d.story) return false;
  const rec = store.get(storyLaneId(d.laneId, d.story));
  if (!rec || STORY_DONE.includes(rec.stage)) return false;
  store.post(rec.id, `${answerMessage(d)}\nYour PM asked this one; Orbit passed the answer on.`);
  deliverMail(store, host, rec.id);
  return true;
}

/** The stage a waking story goes back to: building if it had planned before it waited. */
function resumeStage(rec: StoryRecord): StoryStage {
  return rec.reports.at(-1)?.stage === 'planned' ? 'building' : 'starting';
}

function sameStories(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}

/**
 * Stories whose moon never got a session: started while memory held it, or gone before it came up.
 * Their PM was told the moon starts by itself, and with no session nothing else can resume it, so
 * Orbit starts them again after a restart.
 */
export function unstartedMoons(store: StoryStore, host: Pick<MoonHost, 'isLive' | 'lane'>): string[] {
  return store
    .list()
    .filter((r) => r.stage === 'starting' && !host.isLive(r.id) && !host.lane(r.id)?.sessionId)
    .map((r) => r.id);
}

/**
 * Wake every waiting story whose files are all free: claim them for it, put it back at the stage
 * it waited from, and tell the moon (resuming its session after a restart) and its PM. Oldest
 * first, so the story that waited longest gets a contested file. One still held up waits on
 * whoever holds its files now, which can close a loop and free files, so it goes round until
 * nothing moves. Returns the moons that woke.
 */
export function wakeWaiting(store: StoryStore, host: Pick<MoonHost, 'isLive' | 'send' | 'lane' | 'resume'>): string[] {
  const woke: string[] = [];
  for (let moved = true; moved;) {
    moved = false;
    for (const { id } of store.list()) {
      const rec = store.get(id);
      if (rec?.stage !== 'waiting') continue;
      const want = unique([...rec.files, ...rec.waitingFiles]);
      const holders = store.conflicts(id, want).map((c) => c.storyId);
      if (holders.length) {
        if (!sameStories(holders, rec.waitingOn) && store.park(id, [], holders)?.loop.length) moved = true;
        continue;
      }
      store.update(id, { stage: resumeStage(rec), files: want, waitingOn: [], waitingFiles: [] });
      store.post(
        id,
        `The files you waited on are free and now claimed for this story: ${rec.waitingFiles.join(', ')}. Carry on from where you stopped.`,
      );
      store.post(
        rec.parentId,
        `Story ${rec.storyId} is back to work: ${rec.title}\nThe files it waited on are free and claimed for it.`,
      );
      const sessionId = host.lane(id)?.sessionId;
      if (!host.isLive(id) && sessionId) host.resume(id, sessionId);
      deliverMail(store, host, id);
      deliverMail(store, host, rec.parentId);
      woke.push(id);
      moved = true;
    }
  }
  return woke;
}

export interface PmToolOptions {
  cap: number;
  model: string | null;
  agent: string;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };
type PmLane = { id: string; name: string; cwd: string };

const said = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const refused = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Put a story on a new moon and start its session on the brief. */
function newMoon(
  store: StoryStore,
  host: MoonHost,
  lane: PmLane,
  opts: PmToolOptions,
  story: { storyId: string; title: string; brief: string },
): StoryRecord {
  const rec = store.add({
    id: storyLaneId(lane.id, story.storyId),
    parentId: lane.id,
    parentName: lane.name,
    ...story,
    cwd: lane.cwd,
    agent: opts.agent,
    model: opts.model,
  });
  host.addTransient(storyConfig(rec));
  host.start(rec.id);
  return rec;
}

/**
 * Start a finished story again on the moon it already has, so it keeps its session, worktree, and
 * history: a live moon is told, a stopped one resumes its session first, and one with no session
 * left starts over on the new brief.
 */
function restartStory(
  store: StoryStore,
  host: MoonHost,
  rec: StoryRecord,
  lane: PmLane,
  story: { title: string; brief: string },
): StoryRecord {
  const next = store.update(rec.id, {
    stage: 'starting',
    ...story,
    summary: null,
    files: [],
    waitingOn: [],
    waitingFiles: [],
  })!;
  const sessionId = host.lane(rec.id)?.sessionId;
  if (!host.isLive(rec.id) && sessionId) host.resume(rec.id, sessionId);
  if (host.isLive(rec.id)) {
    store.post(
      rec.id,
      [
        `${lane.name} started this story again. Your worktree, branch, and earlier reports still stand: pick up from there rather than starting over.`,
        '',
        story.brief,
      ].join('\n'),
    );
    deliverMail(store, host, rec.id);
  } else {
    host.removeTransient(rec.id);
    host.addTransient(storyConfig(next));
    host.start(rec.id);
  }
  return next;
}

/**
 * start_story: refuse a story still at work or one past the PM's cap, start a finished one again on
 * the moon it has, and otherwise put the story on a new moon. A moon that does not come up is
 * marked failed and said so, never reported as started.
 */
function startStory(
  store: StoryStore,
  host: MoonHost,
  lane: PmLane,
  opts: PmToolOptions,
  args: { storyId: string; title: string; brief: string },
): ToolResult {
  const storyId = args.storyId.trim();
  const title = args.title.trim();
  const inFlight = store.inFlight(lane.id);
  const existing = store.get(storyLaneId(lane.id, storyId));
  if (existing && !STORY_DONE.includes(existing.stage))
    return refused(
      `Story ${storyId} is already running (${existing.stage}). Read story_status; do not start it twice. To tell it something, use tell_story.`,
    );
  if (inFlight.length >= opts.cap) {
    const list = inFlight.map((s) => `${s.storyId} (${s.stage})`).join(', ');
    return refused(
      `Not started: ${inFlight.length} of ${opts.cap} stories are in flight (${list}). Wait for a report, then try again.`,
    );
  }
  const brief = storyKickoff({ storyId, title, parentName: lane.name, brief: args.brief });
  const rec = existing
    ? restartStory(store, host, existing, lane, { title, brief })
    : newMoon(store, host, lane, opts, { storyId, title, brief });
  const held = host.held?.(rec.id) ?? false;
  if (!host.isLive(rec.id) && !held) {
    store.update(rec.id, { stage: 'failed', summary: 'Its moon did not start.' });
    return refused(`Story ${storyId}'s moon did not start. List it under Blocked in your report.`);
  }
  const slot = `${inFlight.length + 1} of ${opts.cap} in flight`;
  const after = `It will report back as "Story report ${storyId} (planned|pr-opened|blocked|failed)". Carry on with the board; do not run its recipe yourself.`;
  if (held)
    return said(
      `Story ${storyId} is on its own moon (${slot}), but Orbit is holding its start until memory frees up; it starts by itself. Do not start_story it again. ${after}`,
    );
  return said(
    existing
      ? `Started story ${storyId} again on its moon (${slot}); it keeps its session, worktree, and branch. ${after}`
      : `Started story ${storyId} on its own moon (${slot}). ${after}`,
  );
}

/** story_status: one line per story this PM has on a moon, oldest first. */
function storyStatus(store: StoryStore, host: Pick<MoonHost, 'isLive' | 'held'>, laneId: string): ToolResult {
  const mine = store.forParent(laneId);
  if (!mine.length) return said('No stories on moons for this lane.');
  const lines = mine
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => {
      const stage = s.stage === 'waiting' ? `waiting on ${s.waitingOn.join(', ')}` : s.stage;
      const live = host.held?.(s.id) ? 'held for memory' : host.isLive(s.id) ? 'running' : 'not running';
      const pr = s.pr ? ` PR #${s.pr}` : '';
      const files = s.files.length ? ` files: ${s.files.join(', ')}` : '';
      return `${s.storyId} ${s.title} — ${stage}, ${live}${pr}${files}${s.summary ? `\n  last: ${s.summary}` : ''}`;
    });
  return said(lines.join('\n'));
}

/**
 * tell_story: pass a message to one of this PM's stories still in flight. A live moon gets it
 * straight away, even mid-turn; a stopped one resumes its session first. A finished story is
 * refused, since start_story is how it goes back to work.
 */
function tellStory(
  store: StoryStore,
  host: MoonHost,
  lane: PmLane,
  args: { storyId: string; message: string },
): ToolResult {
  const storyId = args.storyId.trim();
  const message = args.message.trim();
  if (!message) return refused('Not sent: the message is empty.');
  const rec = store.get(storyLaneId(lane.id, storyId));
  if (!rec) return refused(`Story ${storyId} is not on one of your moons. Read story_status.`);
  if (STORY_DONE.includes(rec.stage))
    return refused(
      `Story ${storyId} has finished (${rec.stage}), so its moon is not listening. Start it again with start_story and put this in the brief.`,
    );
  const sessionId = host.lane(rec.id)?.sessionId;
  if (!host.isLive(rec.id) && sessionId) host.resume(rec.id, sessionId);
  store.post(rec.id, `Message from the ${lane.name} PM:\n${message}`);
  if (!host.isLive(rec.id))
    return said(
      `Story ${storyId}'s moon is not running and has no session to resume; the message waits for it. List the story under Blocked if it cannot go on without it.`,
    );
  return said(
    deliverMail(store, host, rec.id)
      ? `Sent to story ${storyId}'s moon. Carry on with the board.`
      : `Queued for story ${storyId}'s moon; it goes when the moon can take it. Carry on with the board.`,
  );
}

/**
 * The tools a PM gets for its stories: start one on a moon, tell one in flight something, and
 * read back where they all stand. Bound to one PM lane.
 */
export function pmStoryTools(store: StoryStore, host: MoonHost, lane: PmLane, opts: PmToolOptions) {
  const start = tool(
    'start_story',
    [
      'Hand a story to a session of its own (a moon around your core) that owns it from worktree to pull request: consults, claimed files, TDD lanes, gates, push, PR, ADO moves.',
      'You keep the board, the choice of what to start, and your report; do not run the story recipe yourself once this tool exists.',
      'Refused when you already have the allowed number of stories in flight, or this story is already running. Reports arrive later as user messages starting "Story report <id>".',
      'A story that finished blocked or failed starts again on the moon it has, keeping its session and worktree. A story waiting on files another story holds is still in flight: Orbit wakes it, so do not start it again.',
    ].join(' '),
    {
      storyId: z.string().describe('The story id as its tracker writes it: 100204, ACME-123, or 45.'),
      title: z.string().describe('The story title, as ADO shows it.'),
      brief: z
        .string()
        .describe(
          'Everything the story manager needs that it cannot look up: your domain traps that apply, verbatim; coordinates (repo, aliases, test commands); anything you already know about the story. It runs the consults itself.',
        ),
    },
    async (args) => startStory(store, host, lane, opts, args),
  );
  const status = tool(
    'story_status',
    'Where every story you have handed to a moon stands: stage, PR, claimed files, last report. Read this after a restart before starting anything.',
    {},
    async () => storyStatus(store, host, lane.id),
  );
  const tell = tool(
    'tell_story',
    [
      'Send a message to one of your stories still in flight on its moon: an answer it needs, a correction, a change to its brief. It arrives as a user message, even mid-turn; a moon Orbit stopped resumes first.',
      'Product answers to questions you tagged with the story reach its moon by themselves; do not relay those.',
      'A story that finished (pr-opened, blocked, failed) is not listening: start it again with start_story and put the message in the brief.',
    ].join(' '),
    {
      storyId: z.string().describe('The story id as its tracker writes it: 100204, ACME-123, or 45.'),
      message: z.string().describe('What the story manager needs to hear, as plainly as you would say it in Teams.'),
    },
    async (args) => tellStory(store, host, lane, args),
  );
  return [start, tell, status];
}

/** The note a PM gets when one of its stories is parked on another's files. */
function waitingMessage(rec: StoryRecord, taken: Array<{ storyId: string; files: string[] }>): string {
  const holds = taken.map((t) => `Story ${t.storyId} holds ${t.files.join(', ')}.`).join(' ');
  return [
    `Story ${rec.storyId} is waiting on ${taken.map((t) => t.storyId).join(', ')}: ${rec.title}`,
    `${holds} Orbit wakes it with the files claimed when they are free; do not start_story it. It still counts toward your stories in flight.`,
  ].join('\n');
}

/**
 * claim_files: claim the paths for this story, or, when another story holds any of them, park it
 * as waiting and tell its PM; Orbit wakes it with the files claimed once they are free. A waiting
 * story that claims again asks for everything it was waiting on too.
 */
function claimFiles(
  store: StoryStore,
  host: Pick<MoonHost, 'isLive' | 'send'>,
  laneId: string,
  paths: string[],
): ToolResult {
  const rec = store.get(laneId);
  if (!rec) return refused('This lane is not a story moon.');
  const waiting = rec.stage === 'waiting';
  const want = unique([...(waiting ? rec.waitingFiles : []), ...paths]);
  const taken = store.conflicts(laneId, want);
  if (!taken.length) {
    const files = unique([...rec.files, ...want]);
    store.update(laneId, { files, ...(waiting ? { stage: resumeStage(rec), waitingOn: [], waitingFiles: [] } : {}) });
    return said(`Claimed ${paths.length} file(s); this story now holds ${files.length}.`);
  }
  const { loop } = store.park(
    laneId,
    paths,
    taken.map((t) => t.storyId),
  )!;
  store.post(rec.parentId, waitingMessage(rec, taken));
  deliverMail(store, host, rec.parentId);
  const yielded = loop.length
    ? [
        `Story ${loop.join(', ')} ${loop.length === 1 ? 'is' : 'are'} waiting on this one, so Orbit let go of the files this story held; it claims them back for you when you wake.`,
      ]
    : [];
  return refused(
    [
      'Not claimed; another story holds some of these files:',
      ...taken.map((t) => `- story ${t.storyId} holds ${t.files.join(', ')}`),
      ...yielded,
      'Orbit has parked this story as waiting. End your turn now; when the files are free, Orbit claims them for you and tells you to carry on.',
    ].join('\n'),
  );
}

/** The tools a story moon gets: claim the files it will edit, and report to its PM. Bound to one moon. */
export function moonTools(store: StoryStore, host: Pick<MoonHost, 'isLive' | 'send'>, lane: { id: string }) {
  const claim = tool(
    'claim_files',
    'Claim the files this story will edit, before any lane edits them. Two stories in flight never hold the same file; if another holds one of yours, Orbit parks this story as waiting and wakes it with the files claimed once they are free. End your turn when it says so, rather than editing.',
    {
      paths: z.array(z.string()).min(1).describe('Repo-relative paths, as the architect listed them.'),
    },
    async (args) => claimFiles(store, host, lane.id, args.paths),
  );
  const report = tool(
    'report_to_pm',
    [
      'Tell your PM where the story stands. Use it exactly at: planned (consults done, files claimed, lanes about to start), pr-opened, blocked, or failed.',
      'After pr-opened, blocked, or failed you are finished: end your turn without further work.',
      'Files another story holds are not blocked: claim_files parks you until they are free.',
    ].join(' '),
    {
      stage: z.enum(REPORT_STAGES),
      summary: z.string().describe('Two to five plain sentences the PM can paste into its board report.'),
      pr: z.number().int().optional().describe('The pull request number, for pr-opened.'),
      prUrl: z.string().optional(),
      worktree: z.string().optional().describe('The worktree path, for planned.'),
      branch: z.string().optional().describe('The branch name, for planned.'),
    },
    async (args) => {
      const rec = store.get(lane.id);
      if (!rec) return refused('This lane is not a story moon.');
      if (args.stage === 'pr-opened' && !args.pr) return refused('A pr-opened report needs the PR number.');
      const stage: StoryStage = args.stage === 'planned' ? 'building' : args.stage;
      const next = store.update(lane.id, {
        stage,
        summary: args.summary.trim(),
        pr: args.pr ?? rec.pr,
        prUrl: args.prUrl ?? rec.prUrl,
        worktree: args.worktree ?? rec.worktree,
        branch: args.branch ?? rec.branch,
        waitingOn: [],
        waitingFiles: [],
        reports: [...rec.reports, { at: Date.now(), stage: args.stage, summary: args.summary.trim() }],
      })!;
      store.post(rec.parentId, reportMessage(next, args.stage, args.summary));
      deliverMail(store, host, rec.parentId);
      return said(
        STORY_DONE.includes(stage)
          ? `Reported ${args.stage} to ${rec.parentName}. You are finished with this story; end your turn now.`
          : `Reported ${args.stage} to ${rec.parentName}. Carry on with the lanes.`,
      );
    },
  );
  return [claim, report];
}
