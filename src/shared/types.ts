export type LaneKind = 'project' | 'monitor' | 'chat' | 'review' | 'story';
export type LaneStatus = 'starting' | 'working' | 'idle' | 'needs-you' | 'error' | 'stopped';
export type AgentState = 'working' | 'done' | 'failed' | 'stopped';
export type ErrorCode = 'exit' | 'api' | 'aws-sso' | 'tracker-auth' | 'memory';
export type Priority = 'now' | 'next';
/** How much memory is left: plenty, low enough to cut the test slots to one, or almost out. */
export type MemoryState = 'normal' | 'holding' | 'critical';

export interface AdoAnchor {
  org: string;
  project: string;
  anchorId: number;
}

export type TrackerKind = 'ado' | 'jira' | 'github';
/** Where a story is, in words every tracker maps onto; agents and moons only ever deal in these. */
export type OrbitStage = 'not-started' | 'building' | 'in-review' | 'testing' | 'done' | 'blocked';
export const ORBIT_STAGES: readonly OrbitStage[] = [
  'not-started',
  'building',
  'in-review',
  'testing',
  'done',
  'blocked',
];
/** A tracker column's name to the stage it means, for the splits the tracker can't say itself. */
export type StageMap = Record<string, OrbitStage>;

export interface AdoTrackerConfig {
  kind: 'ado';
  org: string;
  project: string;
  anchorId: number;
  stages?: StageMap;
}
export interface JiraTrackerConfig {
  kind: 'jira';
  site: string;
  projectKey: string;
  board: number;
  /** A PM's stories are an epic's children or a JQL filter's matches: exactly one of the two. */
  epic?: string;
  jql?: string;
  stages?: StageMap;
}
export interface GitHubTrackerConfig {
  kind: 'github';
  repo: string;
  /** A Project (v2) number for the full board, or a label for open / PR open / closed: exactly one. */
  project?: number;
  iterationField?: string;
  label?: string;
  stages?: StageMap;
}
export type TrackerConfig = AdoTrackerConfig | JiraTrackerConfig | GitHubTrackerConfig;

/** One sign-in: the ADO org, the Jira site, or github.com. One card per ref, however many PMs share it. */
export interface TrackerRef {
  kind: TrackerKind;
  site: string;
}

/** A PR linked to a story; repo is null when the tracker only knows the number (ADO). */
export interface PrRef {
  repo: string | null;
  number: number;
}

/** One story on any tracker. */
export interface TrackerItem {
  /** The tracker's own id: `100204`, `ACME-123`, `45`. */
  id: string;
  /** How people write it: `100204`, `ACME-123`, `#45`. */
  key: string;
  title: string;
  type: string;
  /** The tracker's column or state name. */
  column: string;
  stage: OrbitStage;
  assignedTo: string | null;
  parentId: string | null;
  prs: PrRef[];
  url: string;
  /** The sprint the item is planned in; null when the tracker has none. */
  sprint: string | null;
}

/** A board column in the tracker's order, coloured for the ring. */
export interface BoardColumn {
  name: string;
  stage: OrbitStage;
  color: string;
}

export interface TrackerBoard {
  projectId: string;
  /** Null for a project with no tracker: its PM runs, its core has no ring. */
  tracker: TrackerRef | null;
  fetchedAt: number;
  columns: BoardColumn[];
  items: TrackerItem[];
  /** The last fetch failed; items are from the previous successful one. */
  stale: boolean;
  error: string | null;
}

export interface ProjectConfig {
  id: string;
  name: string;
  agent: string;
  cwd: string;
  /** The board as Orbit first knew it; read as `tracker: { kind: 'ado', ... }` and never rewritten. */
  ado?: AdoAnchor;
  tracker?: TrackerConfig;
  /** The repo this PM's PRs go to, when its folder's remote is not it. */
  githubRepo?: string;
  kickoff: string;
  model?: string;
}
export interface MonitorConfig {
  id: string;
  name: string;
  skill: string;
  cwd: string;
  /** Fallback cadence for a full sweep; the GitHub watcher wakes the monitor sooner when a PR moves. */
  everyMinutes: number;
  stateFile: string;
  model?: string;
  /** How often Orbit checks your PRs for movement; 0 turns the watcher off. Default 60. */
  watchSeconds?: number;
}
/** A plain Claude Code session you talk to directly. It waits for you instead of running a kickoff. */
export interface ChatConfig {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  kickoff?: string;
}
/** A one-off session that runs the review-pr skill on a teammate's PR. Lives only while the app runs. */
export interface ReviewConfig {
  id: string;
  name: string;
  cwd: string;
  pr: number;
  repo: string;
  url: string;
  model?: string;
}
/** `waiting` is Orbit's, not a report: another story holds files this one asked for. */
export type StoryStage = 'starting' | 'planned' | 'building' | 'waiting' | 'pr-opened' | 'blocked' | 'failed';
/** Stages a story has finished at: its moon has nothing more to do. */
export const STORY_DONE: readonly StoryStage[] = ['pr-opened', 'blocked', 'failed'];
/** Stages a moon can be dismissed at: finished, or parked until another story lets go of its files. */
export const STORY_RESTING: readonly StoryStage[] = [...STORY_DONE, 'waiting'];

/**
 * A story a PM handed to a session of its own. It lives on a moon around the PM's core, owns the
 * story through to its pull request, and reports back to the PM. Kept in stories.json, not the
 * config.
 */
export interface StoryConfig {
  id: string;
  name: string;
  /** The PM's folder; the story makes its own worktree beside it. */
  cwd: string;
  parentId: string;
  storyId: string;
  title: string;
  /** The whole first message: Orbit's header plus the PM's brief. */
  brief: string;
  agent: string;
  model?: string;
}

/** What a story's moon shows and what the PM reads back through story_status. */
export interface StoryInfo {
  storyId: string;
  title: string;
  stage: StoryStage;
  pr: number | null;
  prUrl: string | null;
  /** Files this story has claimed; two live stories never hold the same one. */
  files: string[];
  /** The stories holding files a waiting story asked for. */
  waitingOn?: string[];
  summary: string | null;
  worktree: string | null;
  branch: string | null;
}

export interface OrbitConfig {
  projects: ProjectConfig[];
  monitors: MonitorConfig[];
  chats: ChatConfig[];
  morning: string[];
  alerts: { toast: boolean; sound: boolean };
  adoPollMinutes: number;
  /** Repo for the team PR list; detected from the first lane's folder when omitted. */
  githubRepo?: string;
  /** Model every new review session starts on; omitted means the CLI default. */
  reviewModel?: string;
  /** Where product questions go when you pass them on; enables the Email button. */
  productOwnerEmail?: string;
  /** Light or dark, or follow Windows; omitted means system. */
  theme?: Theme;
  /** Whether PMs may hand stories to moons of their own. Omitted means on; false hides the tools. */
  storyMoons?: boolean;
  /** `false` hides list_board, get_story, move_story, and comment_on_story from every lane. */
  boardTools?: false;
  /** What the lanes call whoever reads Orbit; omitted means the first part of your sign-in name. */
  userName?: string;
  /** All-caps words a product question may use, like your company's or a system's name. */
  productTerms?: string[];
  /** How many stories one PM may have in flight at once. Default 2. */
  storyWipCap?: number;
  /** Model every story moon starts on; omitted means the PM's own model. Fable comes down to Opus. */
  storyModel?: string;
  /** The agent a story moon runs. Default story-manager. */
  storyAgent?: string;
  /** How many heavy test or build commands may run at once across every lane. Default 2. */
  testSlots?: number;
  /** Free memory, in GB, below which the line drops to one slot and new moons wait. Default 8. */
  memoryHoldGb?: number;
  /** Free memory, in GB, at which that ends. Default 10. */
  memoryResumeGb?: number;
  /** Free memory, in GB, below which no heavy command starts and Orbit alerts you. Default 3. */
  memoryCriticalGb?: number;
}

export type Theme = 'dark' | 'light' | 'system';
export type LaneConfig =
  | ({ kind: 'project' } & ProjectConfig)
  | ({ kind: 'monitor' } & MonitorConfig)
  | ({ kind: 'chat' } & ChatConfig)
  | ({ kind: 'review' } & ReviewConfig)
  | ({ kind: 'story' } & StoryConfig);

export interface QuestionOption {
  label: string;
  description: string;
  /** A mockup or snippet to compare options by, shown while the option is focused or picked. */
  preview?: string;
}
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}
/** Question text to answer, as AskUserQuestion takes it: multi-select picks comma-separated. */
export type Answers = Record<string, string>;
/** Per question: the picked option's preview, and any notes you added. */
export type Annotations = Record<string, { preview?: string; notes?: string }>;
export interface QuestionReply {
  answers: Answers;
  annotations?: Annotations;
}

export interface AgentNode {
  taskId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string;
  state: AgentState;
  summary: string | null;
  lastTool: string | null;
  depth: number;
  startedAt: number;
  endedAt: number | null;
  tokens: number;
  /** Tokens already covered by the session's last exact cost figure. */
  settledTokens: number;
  /** Runs in the background, where background_tasks_changed lists it. A foreground agent never shows up there. */
  backgrounded: boolean;
}

/** USD per weighted input token and per raw token for a model, learned from the CLI's own cost figures. */
export interface ModelRate {
  perWeighted: number;
  perToken: number;
  basis: 'list' | 'managed' | 'unknown';
}
export type Rates = Record<string, ModelRate>;

/** How long a finished agent stays on the orbit and in the agents list before it is dropped. */
export const AGENT_RETENTION_MS = 3 * 60_000;

/** How long a bubble stays up after the lane stops working. */
export const BUBBLE_LINGER_MS = 20_000;

export type BubbleKind = 'said' | 'handoff' | 'returned';

/** The latest thing a lane did that is worth a glance: what the PM said, or an agent it sent out or got back. */
export interface Bubble {
  kind: BubbleKind;
  text: string;
  agentType: string | null;
  at: number;
}

export type Severity = 'critical' | 'major' | 'minor' | 'suggestion';

/** One comment the review-pr skill proposes to post, numbered as it showed them. */
export interface Finding {
  n: number;
  severity: Severity;
  file: string;
  line: number;
  gist: string;
  /** The whole comment as it will be posted; a preview from before Orbit posted reviews has none. */
  body?: string;
}

/** What a review lane is waiting on, as it sent it with review_preview: the comments to keep or drop, then a status. */
export interface ReviewPrompt {
  findings: Finding[];
}

/** The status you pick for a review: approve, request changes, or comment only. */
export type ReviewPick = 'approve' | 'request' | 'leave';
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** How Orbit's own post of a review went: what reached GitHub, or why it did not and what you picked. */
export type ReviewResult =
  | { ok: true; at: number; event: ReviewEvent; comments: number; url: string | null }
  | { ok: false; at: number; pick: ReviewPick; error: string };

export interface PmReport {
  at: number;
  shipped: string[];
  inFlight: string[];
  consults: string[];
  drift: string[];
  blocked: string[];
  next: string | null;
}

interface AttentionBase {
  id: string;
  laneId: string;
  raisedAt: number;
}
export interface QuestionItem extends AttentionBase {
  kind: 'question';
  toolUseId: string;
  questions: Question[];
  why: string | null;
}
export interface BlockedItem extends AttentionBase {
  kind: 'blocked';
  story: string;
  decision: string;
  /** What the lane said when it stopped, as markdown; null for a bare report row. */
  text: string | null;
  /** Choices it laid out, each with the reply a click sends. */
  options: Array<{ label: string; reply: string }>;
}
export interface ErrorItem extends AttentionBase {
  kind: 'error';
  code: ErrorCode;
  message: string;
  /** For `tracker-auth`: which sign-in lapsed, so the card offers its fix. */
  tracker?: TrackerRef;
}
export type AttentionItem = QuestionItem | BlockedItem | ErrorItem;

export interface Lane {
  id: string;
  kind: LaneKind;
  name: string;
  sessionId: string | null;
  status: LaneStatus;
  /** The model the session reported, or the one last asked for before it reported. */
  model: string | null;
  /** The model configured or chosen for this lane; null means the CLI default. */
  requestedModel: string | null;
  /** The CLI's own running total for the session, exact as of the last finished turn. */
  costUsd: number;
  /** A guess at what the turn in progress has spent so far; 0 between turns. */
  costInflightUsd: number;
  /** The priced-API-response part of costInflightUsd, before agents' tokens are added. */
  inflightMainUsd: number;
  /** Which price table the CLI used for costUsd; 'unknown' means it guessed. */
  costBasis: 'list' | 'managed' | 'unknown' | null;
  /** The last API response already counted into costInflightUsd. */
  pricedMessageId: string | null;
  startedAt: number | null;
  /** The one line the lane last posted with post_status. */
  lastSummary: string | null;
  bubble: Bubble | null;
  /** The board as the PM last sent it with report_board. */
  lastReport: PmReport | null;
  /** The review preview waiting on your pick; null once you reply. */
  reviewPrompt: ReviewPrompt | null;
  /** Orbit's post of that review, once you picked a status; null until then and after any reply. */
  reviewResult: ReviewResult | null;
  nextTickAt: number | null;
  agents: AgentNode[];
  /** Grows with every entry added to the lane's live feed, so views know when to refetch. */
  feedCount: number;
  /** The pull request a review lane is about; null for every other kind. */
  pr: { number: number; url: string } | null;
  /** The PM a story moon belongs to; null for a lane on the home row. */
  parentId: string | null;
  /** The story a moon is working; null for every other kind. */
  story: StoryInfo | null;
  error: string | null;
}

export interface HostSnapshot {
  lanes: Lane[];
  attention: AttentionItem[];
  /** Everything every lane finished spending today, across sessions and fresh starts. */
  spentTodayUsd: number;
}

export interface Snapshot extends HostSnapshot {
  boards: TrackerBoard[];
  prBoards: PrBoard[];
  teamPrs: TeamPrBoard;
  /** Colors agent files declare in their front matter, by agent name. */
  agentColors: Record<string, string>;
  /** Product questions the PMs have raised, open and recently answered. */
  decisions: Decision[];
  /** Every PR merged on a PM's stories, as stars in its PM's constellations. */
  stars: Star[];
  /** Each PM's sprint the sky is lit for, and the one before it that fades, by PM lane id. */
  sprints: Record<string, SprintSky>;
  /** Free memory and the shared test slots; absent from older fixtures. */
  guard?: GuardView;
}

/** A heavy command holding one of the shared test slots. */
export interface SlotView {
  laneId: string;
  /** The subagent that ran it; null for the lane's own session. */
  agentId: string | null;
  label: string;
  startedAt: number;
  background: boolean;
}

/** A heavy command in line for a slot, or a moon whose start waits for memory. */
export interface WaitView {
  laneId: string;
  agentId: string | null;
  label: string;
  since: number;
  /** slot: every slot is taken. memory: low memory cut the slots, or holds the launch. */
  reason: 'slot' | 'memory';
  kind: 'command' | 'launch';
}

/** What the corner panel shows. */
export interface GuardView {
  headroomBytes: number;
  /** Installed memory, for the panel's bar; 0 when unknown. */
  totalBytes: number;
  state: MemoryState;
  slots: SlotView[];
  waiting: WaitView[];
}

/** A PR merged on one of a PM's stories: one star in its PM's constellation. */
export interface Star {
  /** `<pmId>-pr-<number>`; a PR earns one star per PM. */
  id: string;
  pmId: string;
  storyId: string;
  title: string;
  pr: number | null;
  prUrl: string | null;
  /** The path of the sprint it merged in; one sprint's stars make one constellation. */
  sprint: string | null;
  /** When the PR merged. */
  at: number;
}

/** A sprint as ADO plans it: from local midnight on its first day to local midnight after its last. */
export interface SprintWindow {
  name: string;
  /** The iteration path, e.g. `Storefront\Sprint 14 (9.30 - 10.20)`. */
  path: string;
  start: number;
  finish: number;
}

export interface SprintSky {
  current: SprintWindow | null;
  previous: SprintWindow | null;
}

export type DecisionStatus = 'open' | 'answered';

/**
 * A product question a PM could not settle on its own, written for the product owner. It stays
 * until you answer it or let it go, so a stack of them can be passed on together.
 */
export interface Decision {
  id: string;
  /** Short number people can refer to: Q12. */
  n: number;
  laneId: string;
  laneName: string;
  question: string;
  /** What the legacy app does today, in plain words. */
  today: string;
  /** What the new app would do if the PM had to guess. */
  proposed: string | null;
  /** Plain choices, the first one recommended. */
  options: string[];
  /** ADO story id or short title, when there is one. */
  story: string | null;
  askedAt: number;
  status: DecisionStatus;
  answer: string | null;
  answeredAt: number | null;
  /** When the answer reached the PM; null while it waits for the lane to run. */
  deliveredAt: number | null;
  /** When you passed it on to the product owner; null if you have not. */
  sentAt: number | null;
}

export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required' | 'none';
export type CheckSummary = 'success' | 'failure' | 'pending' | 'none';

/** A teammate's open, non-draft pull request as the Reviews list shows it. */
export interface TeamPr {
  /** `owner/name`: PMs can live on different repos, so a number alone is not a PR. */
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  branch: string;
  updatedAt: number;
  decision: ReviewDecision;
  checks: CheckSummary;
  /** You were asked for a review directly, or through one of your teams. */
  requested: 'you' | 'team' | null;
  additions: number;
  deletions: number;
}

export interface TeamPrBoard {
  /** Every repo the list was gathered from, in lane order. */
  repos: string[];
  fetchedAt: number;
  prs: TeamPr[];
  error: string | null;
}

export type PrStageState = 'good' | 'busy' | 'warn' | 'bad' | 'pending';

export interface PrLane {
  number: number;
  title: string;
  story: string | null;
  bucket: string;
  status: string;
  note: string | null;
  url: string;
  stages: Record<string, { state: PrStageState; label: string }>;
}

export interface PrBoard {
  monitorId: string;
  fetchedAt: number;
  repo: string | null;
  lanes: PrLane[];
  activity: Array<{ at: number; text: string }>;
}

export type FeedKind = 'text' | 'tool' | 'result' | 'user';

export interface FeedEntry {
  kind: FeedKind;
  text: string;
  /** Tool name for `tool` and `result` entries. */
  tool: string | null;
}

/** A screenshot sent with a message: its type and its bytes as base64, already sized to send. */
export interface ImageAttachment {
  mediaType: string;
  data: string;
}

export interface PersistedLane {
  id: string;
  sessionId: string | null;
  status: LaneStatus;
  startedAt: number | null;
  costUsd: number;
}
export interface PersistedState {
  lanes: PersistedLane[];
  savedAt: number;
  /** Per-model prices learned from finished turns, so the next turn's guess starts informed. */
  rates?: Rates;
  spent?: { day: string; usd: number };
}

export function emptyLane(cfg: LaneConfig): Lane {
  return {
    id: cfg.id,
    kind: cfg.kind,
    name: cfg.name,
    sessionId: null,
    status: 'stopped',
    model: null,
    requestedModel: cfg.model ?? null,
    costUsd: 0,
    costInflightUsd: 0,
    inflightMainUsd: 0,
    costBasis: null,
    pricedMessageId: null,
    startedAt: null,
    lastSummary: null,
    bubble: null,
    lastReport: null,
    reviewPrompt: null,
    reviewResult: null,
    nextTickAt: null,
    agents: [],
    feedCount: 0,
    pr: cfg.kind === 'review' ? { number: cfg.pr, url: cfg.url } : null,
    parentId: cfg.kind === 'story' ? cfg.parentId : null,
    story:
      cfg.kind === 'story'
        ? {
            storyId: cfg.storyId,
            title: cfg.title,
            stage: 'starting',
            pr: null,
            prUrl: null,
            files: [],
            summary: null,
            worktree: null,
            branch: null,
          }
        : null,
    error: null,
  };
}

export interface AgentOption {
  name: string;
  description: string;
  source: 'user' | 'project';
  /** The `color` the agent file declares, as hex; null when it declares none. */
  color: string | null;
}

export interface ModelOption {
  value: string;
  label: string;
}
