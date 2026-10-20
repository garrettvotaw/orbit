import type {
  AgentOption,
  Annotations,
  Answers,
  FeedEntry,
  ImageAttachment,
  LaneConfig,
  ModelOption,
  OrbitConfig,
  Priority,
  ReviewPick,
  Snapshot,
  Theme,
} from './types.ts';

export type OrbitCommand =
  | { type: 'start'; laneId: string }
  | { type: 'resume'; laneId: string }
  | { type: 'fresh'; laneId: string }
  | { type: 'stop'; laneId: string }
  | { type: 'morning' }
  | { type: 'evening' }
  | { type: 'send'; laneId: string; text: string; priority: Priority; images?: ImageAttachment[] }
  | { type: 'answer'; attentionId: string; answers: Answers; annotations?: Annotations }
  | { type: 'dismiss'; attentionId: string }
  | { type: 'ssoLogin'; laneId: string }
  /** Runs the lane's tracker sign-in: az login, or gh auth login in a terminal. Jira signs in on the card. */
  | { type: 'trackerLogin'; laneId: string }
  | { type: 'saveJiraLogin'; site: string; email: string; token: string }
  | { type: 'refreshBoard'; laneId: string }
  | { type: 'addLane'; lane: LaneConfig }
  | { type: 'removeLane'; laneId: string }
  | { type: 'dismissStory'; laneId: string }
  | { type: 'setModel'; laneId: string; model: string | null }
  | { type: 'setReviewModel'; model: string | null }
  | { type: 'reviewPr'; repo: string; number: number }
  | { type: 'postReview'; laneId: string; dropped: number[]; pick: ReviewPick }
  | { type: 'refreshTeamPrs' }
  | { type: 'openExternal'; url: string }
  | { type: 'copyText'; text: string }
  | { type: 'answerDecision'; id: string; answer: string }
  | { type: 'dismissDecision'; id: string }
  | { type: 'markDecisionsSent'; ids: string[] }
  | { type: 'setTheme'; theme: Theme };

/** Round-trip requests that return data, unlike commands. */
export type OrbitRequest =
  { type: 'feed'; laneId: string; agentId: string | null } | { type: 'agents'; cwd: string } | { type: 'models' };

export interface FeedResponse {
  entries: FeedEntry[];
  /** Why the feed is empty, when it is. */
  note: string | null;
}
export interface AgentsResponse {
  agents: AgentOption[];
}
export interface ModelsResponse {
  models: ModelOption[];
}
export type OrbitResponse = FeedResponse | AgentsResponse | ModelsResponse;

export type OrbitEvent = { type: 'snapshot'; snapshot: Snapshot } | { type: 'config'; config: OrbitConfig };

/** What a command reports back. Only send says anything: whether a running lane took the message. */
export interface CommandResult {
  delivered: boolean;
}

export interface OrbitApi {
  onEvent(cb: (e: OrbitEvent) => void): () => void;
  command(cmd: OrbitCommand): Promise<CommandResult | undefined>;
  request(req: { type: 'feed'; laneId: string; agentId: string | null }): Promise<FeedResponse>;
  request(req: { type: 'agents'; cwd: string }): Promise<AgentsResponse>;
  request(req: { type: 'models' }): Promise<ModelsResponse>;
}

export const IPC = { event: 'orbit:event', command: 'orbit:command', request: 'orbit:request' } as const;
