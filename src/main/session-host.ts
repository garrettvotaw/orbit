import type {
  FeedEntry,
  ImageAttachment,
  Lane,
  LaneConfig,
  ModelOption,
  PersistedLane,
  PmReport,
  Priority,
  Question,
  HostSnapshot,
  Rates,
  ReviewPrompt,
  ReviewResult,
  WaitView,
} from '../shared/types.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emptyLane } from '../shared/types.ts';
import { userContent, withScreenshots } from './attachments.ts';
import { AttentionQueue } from './attention.ts';
import { ratesFrom, SpendLedger, type ModelUsage } from './cost.ts';
import { toFeed } from './feed.ts';
import { heavyLabel } from './heavy.ts';
import { PushableStream } from './input-stream.ts';
import { laneRules, type LaneSink, type NeedsYou } from './lane-tools.ts';
import { errorCodeFor, pruneAgents, reduceLane, stopAgents, type SdkMsg } from './reducer.ts';
import type { TestSlots } from './slots.ts';
import { STARTER } from './starter.ts';

export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: ReturnType<typeof userContent> };
  parent_tool_use_id: null;
  priority?: 'now' | 'next' | 'later';
}
export interface QueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
  setModel?(model?: string): Promise<void>;
  supportedModels?(): Promise<Array<{ value: string; displayName: string }>>;
}
export type QueryFactory = (args: {
  prompt: AsyncIterable<SdkUserMessage>;
  options: Record<string, unknown>;
}) => QueryLike;

interface Live {
  q: QueryLike;
  input: PushableStream<SdkUserMessage>;
  abort: AbortController;
  stopping: boolean;
  /** Settles when the pump has drained, which means the CLI process is gone. */
  done: Promise<void>;
  finish: () => void;
}

interface ToolContext {
  signal: AbortSignal;
  toolUseID: string;
}

/** The parts of a Bash hook's input the test-slot line reads. */
interface BashHookInput {
  tool_use_id: string;
  tool_input?: { command?: unknown; run_in_background?: unknown };
  agent_id?: string;
}

/** The system messages that say where a Bash command's task stands. */
type TaskMsg =
  | { subtype: 'task_started'; task_id: string; tool_use_id?: string; is_backgrounded?: boolean }
  | { subtype: 'task_updated'; task_id: string; patch?: { is_backgrounded?: boolean } }
  | { subtype: 'task_notification'; task_id: string; tool_use_id?: string }
  | { subtype: 'background_tasks_changed'; tasks?: Array<{ task_id: string }> };

/** How long a heavy command may wait in line before the CLI gives up on the hook. */
const GATE_TIMEOUT_S = 3_600;
/** A lane in an Nx repo runs Nx two tasks at a time and without a daemon, which each worktree would otherwise leave running. */
const LANE_NX_ENV = { NX_PARALLEL: '2', NX_DAEMON: 'false' };
const nxEnvFor = (cwd: string) => (existsSync(join(cwd, 'nx.json')) ? LANE_NX_ENV : {});

const RESUME_PROMPT = 'You were interrupted. Re-derive the board and continue.';
const CHAT_RESUME_PROMPT = 'You were interrupted. Pick up where we left off.';
const STORY_RESUME_PROMPT =
  'You were interrupted. Check where your story stands (its worktree, branch, PR, and the reports you already sent your PM) and carry on from there; any lane that was running was stopped, so redo its last step if its work is not in the worktree.';
const MONITOR_KICKOFF = (skill: string) =>
  `Run the ${skill} skill. Do not arm a cron and do not start serve.js; the host watches GitHub for you and sends a "tick" message when one of your PRs moves, listing what changed, plus a plain "tick" on a slow fallback schedule. On each tick: sweep (start with the PRs the tick names), act, update state.json, then post_status with one line. When something only I can do or decide comes up, like a merge call or a thread only I can resolve, raise it with needs_you and keep working the other PRs; a question in your reply text never reaches me. Product questions go to ask_product_owner; check list_product_questions first so you never ask twice.`;
/** A PM with a domain file reads it before its own kickoff. */
const PROJECT_KICKOFF = (kickoff: string, domain?: string) =>
  domain ? `Your PM domain file is ${domain}; read it before anything else.\n\n${kickoff}` : kickoff;
/** The skill reads $ARGUMENTS from the slash command, so the kickoff is the command itself. */
const REVIEW_KICKOFF = (pr: number, skill: string) => `/${skill} ${pr}`;
const AUTO_RESUME_MS = 60_000;
const INTERRUPT_GRACE_MS = 3_000;
/** The SDK gives a closed CLI about two seconds to exit on its own and force-kills it five seconds later. */
const EXIT_GRACE_MS = 8_000;
const FEED_CAP = 500;

/** Ask the session to interrupt, but never wait longer than the grace period for an unresponsive process. */
async function interruptWithin(q: QueryLike, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([q.interrupt().then(() => undefined), grace]);
  } catch {
    // session already gone
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SessionHost implements LaneSink {
  readonly #cfgs = new Map<string, LaneConfig>();
  readonly #lanes = new Map<string, Lane>();
  readonly #live = new Map<string, Live>();
  readonly #feeds = new Map<string, FeedEntry[]>();
  readonly #toolNames = new Map<string, Map<string, string>>();
  readonly #transient = new Map<string, LaneConfig>();
  readonly #asking = new Set<string>();
  readonly #autoResumed = new Set<string>();
  readonly #listeners = new Set<(s: HostSnapshot) => void>();
  readonly #query: QueryFactory;
  readonly #attention: AttentionQueue;
  readonly #now: () => number;
  readonly #setTimeout: typeof setTimeout;
  readonly #baseOptions: Record<string, unknown>;
  readonly #toolsFor: ((cfg: LaneConfig) => Record<string, unknown> | null) | null;
  readonly #slots: TestSlots | null;
  readonly #admit: () => boolean;
  readonly #killLane: (laneId: string) => void;
  readonly #userName: () => string;
  readonly #reviewSkill: () => string;
  /** Launches waiting for memory, oldest first, with the session each resumes (null starts fresh). */
  readonly #held = new Map<string, { sessionId: string | null; since: number }>();
  /** The Bash tool call behind each task the CLI reported, for task messages that name only the task. */
  readonly #taskTools = new Map<string, string>();
  #rates: Rates = {};
  #spent: SpendLedger;

  constructor(deps: {
    query: QueryFactory;
    attention: AttentionQueue;
    now?: () => number;
    setTimeout?: typeof setTimeout;
    /** Options merged into every query() call before the lane-specific ones. */
    baseOptions?: Record<string, unknown>;
    /** MCP servers to hand a lane's session, by lane; null for none. */
    toolsFor?: (cfg: LaneConfig) => Record<string, unknown> | null;
    /** The shared line heavy Bash commands wait in; none means they run at once. */
    slots?: TestSlots;
    /** Whether memory allows a launch Orbit or a PM asked for; your own starts never ask. */
    admit?: () => boolean;
    /** Kill a lane's process trees, for a stop that would otherwise leave its tests running. */
    killLane?: (laneId: string) => void;
    /** What the lane rules call whoever reads Orbit. */
    userName?: () => string;
    /** The skill a review lane runs, read each time one starts. */
    reviewSkill?: () => string;
  }) {
    this.#query = deps.query;
    this.#attention = deps.attention;
    this.#now = deps.now ?? Date.now;
    this.#setTimeout = deps.setTimeout ?? setTimeout;
    this.#baseOptions = deps.baseOptions ?? {};
    this.#toolsFor = deps.toolsFor ?? null;
    this.#slots = deps.slots ?? null;
    this.#admit = deps.admit ?? (() => true);
    this.#killLane = deps.killLane ?? (() => {});
    this.#userName = deps.userName ?? (() => 'the user');
    this.#reviewSkill = deps.reviewSkill ?? (() => STARTER.reviewSkill);
    this.#spent = new SpendLedger(null, this.#now());
    this.#attention.onChange(() => this.#emit());
  }

  /** Prices learned from finished turns and today's spend, as the state file keeps them. */
  accounting(): { rates: Rates; spent: { day: string; usd: number } } {
    return { rates: this.#rates, spent: this.#spent.toJSON() };
  }

  /** Restore learned prices and today's spend from the last run. */
  hydrateAccounting(saved: { rates?: Rates; spent?: { day: string; usd: number } }): void {
    this.#rates = { ...(saved.rates ?? {}) };
    this.#spent = new SpendLedger(saved.spent ?? null, this.#now());
    this.#emit();
  }

  setLanes(cfgs: LaneConfig[]): void {
    const all = [...cfgs, ...[...this.#transient.values()].filter((t) => !cfgs.some((c) => c.id === t.id))];
    const keep = new Set(all.map((c) => c.id));
    for (const id of [...this.#lanes.keys()]) {
      if (!keep.has(id) && !this.#live.has(id)) {
        this.#lanes.delete(id);
        this.#cfgs.delete(id);
      }
    }
    for (const c of all) {
      this.#cfgs.set(c.id, c);
      const existing = this.#lanes.get(c.id);
      this.#lanes.set(
        c.id,
        existing
          ? {
              ...existing,
              name: c.name,
              requestedModel: this.#live.has(c.id) ? existing.requestedModel : (c.model ?? null),
            }
          : emptyLane(c),
      );
      if (!this.#live.has(c.id)) this.#feeds.delete(c.id);
    }
    for (const id of [...this.#feeds.keys()]) if (!keep.has(id)) this.#feeds.delete(id);
    this.#emit();
  }

  /** Add a lane that lives only while the app runs (a PR review). Returns false if the id is taken. */
  addTransient(cfg: LaneConfig): boolean {
    if (this.#cfgs.has(cfg.id)) return false;
    this.#transient.set(cfg.id, cfg);
    this.#cfgs.set(cfg.id, cfg);
    this.#lanes.set(cfg.id, emptyLane(cfg));
    this.#emit();
    return true;
  }

  isTransient(laneId: string): boolean {
    return this.#transient.has(laneId);
  }

  /** Forget a stopped transient lane. Live ones stay until stopped. */
  removeTransient(laneId: string): boolean {
    if (!this.#transient.has(laneId) || this.#live.has(laneId)) return false;
    this.#held.delete(laneId);
    this.#transient.delete(laneId);
    this.#cfgs.delete(laneId);
    this.#lanes.delete(laneId);
    this.#feeds.delete(laneId);
    this.#attention.clearLane(laneId);
    this.#emit();
    return true;
  }

  hydrate(persisted: PersistedLane[]): void {
    for (const p of persisted) {
      const lane = this.#lanes.get(p.id);
      if (!lane || this.#live.has(p.id)) continue;
      this.#lanes.set(p.id, {
        ...lane,
        sessionId: p.sessionId,
        costUsd: p.costUsd,
        startedAt: p.startedAt,
        status: 'stopped',
      });
    }
    this.#emit();
  }

  snapshot(): HostSnapshot {
    return {
      lanes: [...this.#cfgs.keys()].map((id) => this.#lanes.get(id)!),
      attention: this.#attention.items(),
      spentTodayUsd: this.#spent.today(this.#now()),
    };
  }

  onChange(cb: (s: HostSnapshot) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  isLive(laneId: string): boolean {
    return this.#live.has(laneId);
  }

  lane(laneId: string): Lane | undefined {
    return this.#lanes.get(laneId);
  }

  setNextTick(laneId: string, at: number | null): void {
    const lane = this.#lanes.get(laneId);
    if (!lane || lane.nextTickAt === at) return;
    this.#patch(laneId, (l) => ({ ...l, nextTickAt: at }));
  }

  /** Drop agents past the retention window on every lane, even ones with no new messages. */
  sweep(now = this.#now()): void {
    let changed = false;
    for (const [id, lane] of this.#lanes) {
      const next = pruneAgents(lane, now);
      if (next !== lane) {
        this.#lanes.set(id, next);
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  start(laneId: string): void {
    this.#held.delete(laneId);
    this.#launch(laneId, null);
  }

  resume(laneId: string, sessionId: string): void {
    this.#held.delete(laneId);
    this.#launch(laneId, sessionId);
  }

  /** A start Orbit or a PM asked for: now if memory allows, otherwise once it does. */
  startWhenRoom(laneId: string): void {
    this.#launchWhenRoom(laneId, null);
  }

  resumeWhenRoom(laneId: string, sessionId: string): void {
    this.#launchWhenRoom(laneId, sessionId);
  }

  isHeld(laneId: string): boolean {
    return this.#held.has(laneId);
  }

  /** The launches waiting for memory, oldest first, as the corner panel lists them. */
  heldView(): WaitView[] {
    return [...this.#held].map(([laneId, h]) => ({
      laneId,
      agentId: null,
      label: 'moon start',
      since: h.since,
      reason: 'memory',
      kind: 'launch',
    }));
  }

  /** Launch the launch that has waited longest, if memory allows; returns its lane. */
  releaseHeld(): string | null {
    const next = this.#held.entries().next();
    if (next.done || !this.#admit()) return null;
    const [laneId, { sessionId }] = next.value;
    this.#held.delete(laneId);
    this.#launch(laneId, sessionId);
    return laneId;
  }

  #launchWhenRoom(laneId: string, sessionId: string | null): void {
    if (this.#live.has(laneId) || this.#held.has(laneId)) return;
    if (this.#admit()) {
      this.#launch(laneId, sessionId);
      return;
    }
    this.#held.set(laneId, { sessionId, since: this.#now() });
    this.#emit();
  }

  async fresh(laneId: string): Promise<void> {
    await this.stop(laneId);
    const lane = this.#lanes.get(laneId);
    if (lane) {
      this.#lanes.set(laneId, {
        ...lane,
        sessionId: null,
        costUsd: 0,
        costInflightUsd: 0,
        inflightMainUsd: 0,
        pricedMessageId: null,
        lastReport: null,
        lastSummary: null,
        reviewPrompt: null,
        reviewResult: null,
        bubble: null,
        agents: [],
      });
    }
    this.#autoResumed.delete(laneId);
    this.start(laneId);
  }

  async stop(laneId: string): Promise<void> {
    if (this.#held.delete(laneId)) this.#emit();
    const l = this.#live.get(laneId);
    if (!l) return;
    l.stopping = true;
    // Asked before the interrupt, which frees a foreground slot as it cancels the command.
    const testing = this.#slots?.holds(laneId) ?? false;
    await interruptWithin(l.q, INTERRUPT_GRACE_MS);
    // A test run can outlive its CLI on Windows. Its tree only comes down while the CLI is alive.
    if (testing) this.#killLane(laneId);
    l.q.close();
    l.input.end();
    // Let the process die before settling anything it might still be waiting on. A question that
    // settles while the CLI is alive can be read as an answer, and an answer can post things.
    await Promise.race([l.done, new Promise<void>((r) => setTimeout(r, EXIT_GRACE_MS).unref?.())]);
    this.#live.delete(laneId);
    this.#slots?.dropLane(laneId);
    this.#attention.clearLane(laneId);
    l.abort.abort();
    this.#patch(laneId, (lane) => ({ ...stopAgents(lane, this.#now()), status: 'stopped' }));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((id) => this.stop(id)));
  }

  /** Your message to a lane, with any screenshots ahead of the words. */
  send(laneId: string, text: string, priority: Priority, images: ImageAttachment[] = []): boolean {
    const l = this.#live.get(laneId);
    if (!l || l.input.ended) return false;
    l.input.push({
      type: 'user',
      message: { role: 'user', content: userContent(text, images) },
      parent_tool_use_id: null,
      priority,
    });
    this.#appendFeed(laneId, [{ kind: 'user', text: withScreenshots(text, images.length), tool: null }]);
    // Any reply answers whatever the lane was waiting on.
    this.#attention.clearBlocked(laneId);
    // A message on its way means the lane is about to work, even before the CLI says so.
    this.#patch(laneId, (lane) => ({
      ...lane,
      reviewPrompt: null,
      reviewResult: null,
      status: lane.status === 'idle' ? 'working' : lane.status,
    }));
    return true;
  }

  /** needs_you: the lane's one open ask, on the beacon until you reply, dismiss it, or the lane withdraws it. */
  needsYou(laneId: string, ask: NeedsYou): void {
    if (!this.#lanes.has(laneId)) return;
    this.#attention.clearBlocked(laneId);
    this.#attention.raiseBlocked(laneId, ask.story ?? 'your answer', ask.question, {
      text: ask.question,
      options: ask.options.map((o) => ({ label: o, reply: o })),
    });
  }

  withdrawNeedsYou(laneId: string): boolean {
    const open = this.#attention.items().some((a) => a.laneId === laneId && a.kind === 'blocked');
    this.#attention.clearBlocked(laneId);
    return open;
  }

  /** post_status: the line under the core, and the bubble that says it. */
  postStatus(laneId: string, line: string): void {
    this.#patch(laneId, (l) => ({
      ...l,
      lastSummary: line,
      bubble: { kind: 'said', text: line, agentType: null, at: this.#now() },
    }));
  }

  reportBoard(laneId: string, report: Omit<PmReport, 'at'>): void {
    this.#patch(laneId, (l) => ({ ...l, lastReport: { ...report, at: this.#now() } }));
  }

  /** review_preview: the panel's keep/drop chips, and a nudge that the review is waiting on you. */
  reviewPreview(laneId: string, prompt: ReviewPrompt): void {
    const lane = this.#lanes.get(laneId);
    if (!lane) return;
    this.#patch(laneId, (l) => ({ ...l, reviewPrompt: prompt, reviewResult: null }));
    const n = prompt.findings.length;
    this.#attention.clearBlocked(laneId);
    this.#attention.raiseBlocked(
      laneId,
      lane.pr ? `#${lane.pr.number}` : lane.name,
      n ? `${n} comment${n === 1 ? '' : 's'} to keep or drop, then a status.` : 'No comments. Pick a status.',
    );
  }

  /**
   * Orbit posted the review itself: once it reached GitHub the preview and the nudge are done;
   * when GitHub refused, both stay so you can hand it to Claude.
   */
  reviewPosted(laneId: string, result: ReviewResult): void {
    if (!this.#lanes.has(laneId)) return;
    this.#patch(laneId, (l) => ({ ...l, reviewResult: result, reviewPrompt: result.ok ? null : l.reviewPrompt }));
    if (result.ok) this.#attention.clearBlocked(laneId);
  }

  /** The lane's conversation as seen through the SDK stream since it started or resumed. */
  feed(laneId: string): FeedEntry[] {
    return this.#feeds.get(laneId) ?? [];
  }

  /** Switch the model for a lane: live sessions change on their next turn, stopped ones on their next start. */
  async setModel(laneId: string, model: string | null): Promise<void> {
    const lane = this.#lanes.get(laneId);
    if (!lane) return;
    const live = this.#live.get(laneId);
    if (live?.q.setModel) await live.q.setModel(model ?? undefined);
    this.#patch(laneId, (l) => ({ ...l, requestedModel: model, model: model ?? (live ? l.model : null) }));
  }

  /** Models the CLI advertises, asked of any live session; null when none is live. */
  async models(): Promise<ModelOption[] | null> {
    for (const live of this.#live.values()) {
      if (!live.q.supportedModels) continue;
      try {
        const list = await live.q.supportedModels();
        return list.map((m) => ({ value: m.value, label: m.displayName || m.value }));
      } catch {
        // try the next live session
      }
    }
    return null;
  }

  #launch(laneId: string, resumeSessionId: string | null): void {
    const cfg = this.#cfgs.get(laneId);
    if (!cfg || this.#live.has(laneId)) return;
    const lane = this.#lanes.get(laneId);
    const input = new PushableStream<SdkUserMessage>();
    const abort = new AbortController();
    const kickoff = resumeSessionId
      ? cfg.kind === 'chat' || cfg.kind === 'review'
        ? CHAT_RESUME_PROMPT
        : cfg.kind === 'story'
          ? STORY_RESUME_PROMPT
          : RESUME_PROMPT
      : cfg.kind === 'project'
        ? PROJECT_KICKOFF(cfg.kickoff, cfg.domain)
        : cfg.kind === 'monitor'
          ? MONITOR_KICKOFF(cfg.skill)
          : cfg.kind === 'review'
            ? REVIEW_KICKOFF(cfg.pr, this.#reviewSkill())
            : cfg.kind === 'story'
              ? cfg.brief
              : (cfg.kickoff ?? null);
    if (!resumeSessionId) {
      this.#feeds.delete(laneId);
      this.#toolNames.delete(laneId);
    }
    if (kickoff) {
      input.push({ type: 'user', message: { role: 'user', content: kickoff }, parent_tool_use_id: null });
      this.#appendFeed(laneId, [{ kind: 'user', text: kickoff, tool: null }]);
    }

    const rules = laneRules(cfg.kind, this.#userName());
    const options: Record<string, unknown> = {
      ...this.#baseOptions,
      cwd: cfg.cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(rules ? { append: rules } : {}) },
      tools: { type: 'preset', preset: 'claude_code' },
      agentProgressSummaries: true,
      forwardSubagentText: false,
      includePartialMessages: false,
      env: { ...process.env, ORBIT_LANE: cfg.id, ...nxEnvFor(cfg.cwd) },
      canUseTool: (tool: string, inp: Record<string, unknown>, o: ToolContext) =>
        this.#canUseTool(laneId, tool, inp, o),
    };
    const model = lane?.requestedModel ?? cfg.model;
    if (model) options.model = model;
    if (cfg.kind === 'project' || cfg.kind === 'story') options.agent = cfg.agent;
    const mcpServers = this.#toolsFor?.(cfg);
    if (mcpServers) options.mcpServers = mcpServers;
    const hooks = this.#hooks(laneId);
    if (hooks) options.hooks = hooks;
    if (resumeSessionId) options.resume = resumeSessionId;

    const q = this.#query({ prompt: input, options });
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Live = { q, input, abort, stopping: false, done, finish };
    this.#live.set(laneId, entry);
    this.#patch(laneId, (lane) => ({
      ...lane,
      // A chat with nothing to say yet is simply waiting for you.
      status: kickoff ? 'starting' : 'idle',
      startedAt: this.#now(),
      error: null,
      bubble: null,
      costInflightUsd: 0,
      inflightMainUsd: 0,
      pricedMessageId: null,
      agents: resumeSessionId ? lane.agents : [],
    }));
    void this.#pump(laneId, entry);
  }

  async #pump(laneId: string, entry: Live): Promise<void> {
    let lastErrors: string[] | null = null;
    let lastSubtype = '';
    try {
      for await (const raw of entry.q) {
        const msg = raw as SdkMsg;
        if (msg.type === 'result' && (msg as { subtype: string }).subtype !== 'success') {
          lastErrors = (msg as { errors?: string[] }).errors ?? [];
          lastSubtype = (msg as { subtype: string }).subtype;
        }
        if (msg.type === 'result')
          this.#account(laneId, msg as { total_cost_usd?: number; modelUsage?: Record<string, ModelUsage> });
        if (msg.type === 'system') this.#taskMessage(laneId, msg as unknown as TaskMsg);
        this.#patch(laneId, (lane) => reduceLane(lane, msg, this.#now(), this.#rates));
        this.#feedFrom(laneId, msg);
      }
    } catch (e) {
      lastErrors = [(e as Error).message];
      lastSubtype = 'error_during_execution';
      this.#patch(laneId, (lane) => ({ ...lane, status: 'error', error: (e as Error).message }));
    }
    const wasStopping = entry.stopping;
    entry.finish();
    this.#slots?.dropLane(laneId);
    if (wasStopping) return;
    this.#live.delete(laneId);
    entry.abort.abort();
    this.#attention.clearLane(laneId);
    const lane = this.#lanes.get(laneId);
    if (!lane) return;
    this.#patch(laneId, (l) => stopAgents(l, this.#now()));
    if (lane.status === 'error' || lastErrors) {
      this.#handleError(laneId, lastErrors ?? [lane.error ?? ''], lastSubtype || 'error_during_execution');
    } else {
      this.#patch(laneId, (l) => ({ ...l, status: 'stopped' }));
    }
  }

  #handleError(laneId: string, errors: string[], subtype: string): void {
    const code = errorCodeFor(errors, subtype);
    const lane = this.#lanes.get(laneId)!;
    const message = errors.join('; ') || subtype;
    this.#patch(laneId, (l) => ({ ...l, status: 'error', error: message }));
    if (code === 'api' && lane.sessionId && !this.#autoResumed.has(laneId)) {
      this.#autoResumed.add(laneId);
      const sessionId = lane.sessionId;
      this.#setTimeout(() => {
        if (!this.#live.has(laneId)) this.resumeWhenRoom(laneId, sessionId);
      }, AUTO_RESUME_MS);
      return;
    }
    this.#attention.raiseError(laneId, code, message);
  }

  async #canUseTool(laneId: string, tool: string, input: Record<string, unknown>, o: ToolContext): Promise<unknown> {
    if (tool !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    const questions = (input.questions as Question[]) ?? [];
    const why = this.#lanes.get(laneId)?.lastSummary ?? null;
    const combined = new AbortController();
    const onAbort = () => combined.abort();
    o.signal.addEventListener('abort', onAbort, { once: true });
    this.#live.get(laneId)?.abort.signal.addEventListener('abort', onAbort, { once: true });
    this.#asking.add(laneId);
    this.#patch(laneId, (lane) => ({ ...lane, status: 'needs-you' }));
    try {
      const { answers, annotations } = await this.#attention.ask(laneId, o.toolUseID, questions, why, combined.signal);
      return { behavior: 'allow', updatedInput: { questions, answers, ...(annotations ? { annotations } : {}) } };
    } catch {
      // Never let an unanswered question look like an answer: a thrown callback can be read by
      // the CLI as the first option, and the first option can post a review.
      return {
        behavior: 'deny',
        message: 'Orbit: the lane was stopped before this question was answered. Nothing was chosen; do not act on it.',
      };
    } finally {
      this.#asking.delete(laneId);
      this.#patch(laneId, (lane) => (lane.status === 'needs-you' ? { ...lane, status: 'working' } : lane));
    }
  }

  /** The Bash hooks that put a lane's heavy commands, and its subagents', in the shared line. */
  #hooks(laneId: string): Record<string, unknown> | null {
    const slots = this.#slots;
    if (!slots) return null;
    // A command the CLI moved to the background (at its timeout, say) says so in its result; it keeps
    // its slot until its task ends. Read here because task messages can arrive after this hook.
    const done = async (input: BashHookInput & { tool_response?: { backgroundTaskId?: unknown } }) => {
      const taskId = input.tool_response?.backgroundTaskId;
      if (typeof taskId === 'string') {
        this.#taskTools.set(taskId, input.tool_use_id);
        slots.background(input.tool_use_id, taskId);
      } else slots.finish(input.tool_use_id);
      return {};
    };
    return {
      PreToolUse: [
        {
          matcher: 'Bash',
          timeout: GATE_TIMEOUT_S,
          hooks: [
            (input: BashHookInput, _id: string | undefined, o: { signal: AbortSignal }) =>
              this.#gate(laneId, slots, input, o.signal),
          ],
        },
      ],
      PostToolUse: [{ matcher: 'Bash', hooks: [done] }],
      PostToolUseFailure: [{ matcher: 'Bash', hooks: [done] }],
    };
  }

  /** Hold a heavy command until it has a slot; anything else goes straight through. */
  async #gate(laneId: string, slots: TestSlots, input: BashHookInput, signal: AbortSignal): Promise<object> {
    const command = input.tool_input?.command;
    const label = typeof command === 'string' ? heavyLabel(command) : null;
    if (!label) return {};
    const granted = slots.acquire(
      {
        laneId,
        agentId: input.agent_id ?? null,
        toolUseId: input.tool_use_id,
        label,
        background: input.tool_input?.run_in_background === true,
      },
      signal,
    );
    if (slots.has(input.tool_use_id)) return {};
    const reason = slots.view().waiting.at(-1)?.reason;
    const text = reason === 'memory' ? '⏳ held for memory' : '⏳ waiting for a test slot';
    this.#patch(laneId, (l) => ({ ...l, bubble: { kind: 'said', text, agentType: null, at: this.#now() } }));
    await granted;
    // Its turn came; the bubble would otherwise say it waits all through the run.
    this.#patch(laneId, (l) => (l.bubble?.text === text ? { ...l, bubble: null } : l));
    return {};
  }

  /** Task messages tell the line when a background command ends, which PostToolUse never says. */
  #taskMessage(laneId: string, m: TaskMsg): void {
    const slots = this.#slots;
    if (!slots) return;
    switch (m.subtype) {
      case 'task_started':
        if (!m.tool_use_id) return;
        this.#taskTools.set(m.task_id, m.tool_use_id);
        if (m.is_backgrounded) slots.background(m.tool_use_id, m.task_id);
        else slots.task(m.tool_use_id, m.task_id);
        return;
      case 'task_updated': {
        const toolUseId = this.#taskTools.get(m.task_id);
        if (toolUseId && m.patch?.is_backgrounded) slots.background(toolUseId, m.task_id);
        return;
      }
      case 'task_notification': {
        const toolUseId = m.tool_use_id ?? this.#taskTools.get(m.task_id);
        this.#taskTools.delete(m.task_id);
        if (toolUseId) slots.taskEnded(toolUseId);
        return;
      }
      case 'background_tasks_changed':
        slots.liveTasks(
          laneId,
          (m.tasks ?? []).map((t) => t.task_id),
        );
        return;
    }
  }

  #patch(laneId: string, fn: (lane: Lane) => Lane): void {
    const lane = this.#lanes.get(laneId);
    if (!lane) return;
    const next = fn(lane);
    // While a question is open, the CLI's own state chatter must not hide the fact that it is your turn.
    this.#lanes.set(
      laneId,
      this.#asking.has(laneId) && next.status === 'working' ? { ...next, status: 'needs-you' } : next,
    );
    this.#emit();
  }

  /** Main-thread assistant text, tool calls, and tool results feed the lane's conversation. */
  #feedFrom(laneId: string, msg: SdkMsg): void {
    if (msg.type !== 'assistant' && msg.type !== 'user') return;
    const m = msg as { type: 'assistant' | 'user'; message: unknown; parent_tool_use_id?: string | null };
    if (m.parent_tool_use_id) return;
    let names = this.#toolNames.get(laneId);
    if (!names) this.#toolNames.set(laneId, (names = new Map()));
    const entries = toFeed([{ type: m.type, message: m.message }], names);
    if (entries.length) this.#appendFeed(laneId, entries);
  }

  /**
   * A finished turn teaches the per-model prices and adds what it spent to today's total. The CLI's
   * running total already includes earlier turns, so only the growth since the last figure counts.
   */
  #account(laneId: string, result: { total_cost_usd?: number; modelUsage?: Record<string, ModelUsage> }): void {
    this.#rates = ratesFrom(result.modelUsage, this.#rates);
    const lane = this.#lanes.get(laneId);
    const total = result.total_cost_usd;
    if (lane && typeof total === 'number') this.#spent.add(total - lane.costUsd, this.#now());
  }

  #appendFeed(laneId: string, entries: FeedEntry[]): void {
    const list = this.#feeds.get(laneId) ?? [];
    list.push(...entries);
    if (list.length > FEED_CAP) list.splice(0, list.length - FEED_CAP);
    this.#feeds.set(laneId, list);
    this.#patch(laneId, (l) => ({ ...l, feedCount: l.feedCount + entries.length }));
  }

  #emit(): void {
    const s = this.snapshot();
    for (const l of this.#listeners) l(s);
  }
}
