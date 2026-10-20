import {
  AGENT_RETENTION_MS,
  type AgentNode,
  type Bubble,
  type ErrorCode,
  type Lane,
  type Rates,
} from '../shared/types.ts';
import { basisOf, estimateAgentUsd, estimateUsd, type ApiUsage, type ModelUsage } from './cost.ts';

/** Structural subset of the SDK's SDKMessage. Only the fields the reducer reads. */
export type SdkMsg =
  | { type: 'system'; subtype: 'init'; session_id: string; model: string }
  | { type: 'system'; subtype: 'session_state_changed'; state: 'idle' | 'running' | 'requires_action' }
  | {
      type: 'system';
      subtype: 'task_started';
      task_id: string;
      tool_use_id?: string;
      description: string;
      subagent_type?: string;
      task_type?: string;
      spawn_depth?: number;
      is_backgrounded?: boolean;
      ambient?: boolean;
    }
  | {
      type: 'system';
      subtype: 'task_progress';
      task_id: string;
      description: string;
      subagent_type?: string;
      usage: { total_tokens: number; tool_uses: number; duration_ms: number };
      last_tool_name?: string;
      summary?: string;
    }
  | {
      type: 'system';
      subtype: 'task_updated';
      task_id: string;
      patch: {
        status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
        description?: string;
        end_time?: number;
        error?: string;
        is_backgrounded?: boolean;
      };
    }
  | {
      type: 'system';
      subtype: 'task_notification';
      task_id: string;
      status: 'completed' | 'failed' | 'stopped';
      summary: string;
      ambient?: boolean;
    }
  | {
      type: 'system';
      subtype: 'background_tasks_changed';
      tasks: Array<{ task_id: string; task_type?: string; description: string; ambient?: boolean }>;
    }
  | { type: 'system'; subtype: string }
  | {
      type: 'assistant';
      message: { id?: string; model?: string; usage?: ApiUsage; content: Array<{ type: string; text?: string }> };
      parent_tool_use_id: string | null;
      error?: string;
    }
  | {
      type: 'result';
      subtype: 'success';
      total_cost_usd: number;
      result: string;
      modelUsage?: Record<string, ModelUsage>;
    }
  | {
      type: 'result';
      subtype: string;
      total_cost_usd: number;
      errors?: string[];
      modelUsage?: Record<string, ModelUsage>;
    }
  | { type: string };

export function errorCodeFor(errors: string[], subtype: string): ErrorCode {
  const text = `${subtype}\n${errors.join('\n')}`;
  if (/cloud_credential|aws credentials|sso|expiredtoken/i.test(text)) return 'aws-sso';
  if (/\b5\d\d\b|api_error|overloaded|rate.?limit|throttl/i.test(text)) return 'api';
  return 'exit';
}

function upsertAgent(lane: Lane, taskId: string, make: () => AgentNode, patch: (a: AgentNode) => AgentNode): Lane {
  const idx = lane.agents.findIndex((a) => a.taskId === taskId);
  const agents = [...lane.agents];
  if (idx === -1) agents.push(patch(make()));
  else agents[idx] = patch(agents[idx]);
  return { ...lane, agents };
}

const GIST_MAX = 140;

/** The first real line of some text, without markdown dressing, short enough for a glance. */
export function gist(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:#{1,6}|[-*>]|\d+\.)\s+/, '').trim())
      .find((l) => l && !/^[-*_]{3,}$/.test(l)) ?? '';
  const plain = line.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ');
  return plain.length > GIST_MAX ? `${plain.slice(0, GIST_MAX - 1).trimEnd()}…` : plain;
}

function bubble(kind: Bubble['kind'], text: string, agentType: string | null, at: number): Bubble | null {
  const t = gist(text);
  return t ? { kind, text: t, agentType, at } : null;
}

/**
 * Only spawned agents and teammates orbit a core. Background shell commands, workflows, MCP
 * tasks, and watchers are the PM's plumbing, not people on the team.
 */
export function isAgentTask(t: {
  task_type?: string;
  spawn_depth?: number;
  subagent_type?: string;
  ambient?: boolean;
}): boolean {
  if (t.ambient) return false;
  if (t.task_type !== undefined) return /agent|teammate/i.test(t.task_type);
  return t.spawn_depth !== undefined || t.subagent_type !== undefined;
}

/**
 * Drop agents that finished longer ago than the retention window. One whose spend has not yet
 * been settled by a finished turn stays while the lane works, so the in-flight estimate holds.
 */
export function pruneAgents(lane: Lane, now: number, retentionMs = AGENT_RETENTION_MS): Lane {
  const busy = lane.status === 'working' || lane.status === 'starting';
  const agents = lane.agents.filter(
    (a) =>
      a.state === 'working' ||
      a.endedAt === null ||
      now - a.endedAt <= retentionMs ||
      (busy && a.tokens > a.settledTokens),
  );
  return agents.length === lane.agents.length ? lane : { ...lane, agents };
}

function newAgent(taskId: string, description: string, now: number): AgentNode {
  return {
    taskId,
    toolUseId: null,
    agentType: null,
    description,
    state: 'working',
    summary: null,
    lastTool: null,
    depth: 1,
    startedAt: now,
    endedAt: null,
    tokens: 0,
    settledTokens: 0,
    backgrounded: false,
  };
}

/** Agents still working when their CLI is gone. Nothing will report on them again. */
export function stopAgents(lane: Lane, now: number): Lane {
  return {
    ...lane,
    agents: lane.agents.map((a) => (a.state === 'working' ? { ...a, state: 'stopped', endedAt: now } : a)),
  };
}

/** The in-flight guess: priced API responses plus every agent's unsettled tokens at the lane model's average price. */
function withInflight(lane: Lane, rates: Rates): Lane {
  const agents = lane.agents.reduce(
    (sum, a) => sum + estimateAgentUsd(a.tokens - a.settledTokens, lane.model, rates),
    0,
  );
  const total = lane.inflightMainUsd + agents;
  return total === lane.costInflightUsd ? lane : { ...lane, costInflightUsd: total };
}

export function reduceLane(lane: Lane, msg: SdkMsg, now: number, rates: Rates = {}): Lane {
  return withInflight(pruneAgents(applyMessage(lane, msg, now, rates), now), rates);
}

function applyMessage(lane: Lane, msg: SdkMsg, now: number, rates: Rates): Lane {
  if (msg.type === 'system') {
    const m = msg as Extract<SdkMsg, { type: 'system' }>;
    switch (m.subtype) {
      case 'init': {
        const i = m as Extract<SdkMsg, { subtype: 'init' }>;
        return { ...lane, sessionId: i.session_id, model: i.model, status: 'working', error: null };
      }
      case 'session_state_changed': {
        const s = m as Extract<SdkMsg, { subtype: 'session_state_changed' }>;
        const status = s.state === 'requires_action' ? 'needs-you' : s.state === 'running' ? 'working' : 'idle';
        return { ...lane, status };
      }
      case 'task_started': {
        const t = m as Extract<SdkMsg, { subtype: 'task_started' }>;
        if (!isAgentTask(t)) return lane;
        const started = upsertAgent(
          lane,
          t.task_id,
          () => newAgent(t.task_id, t.description, now),
          (a) => ({
            ...a,
            toolUseId: t.tool_use_id ?? a.toolUseId,
            agentType: t.subagent_type ?? a.agentType,
            description: t.description,
            depth: t.spawn_depth ?? a.depth,
            backgrounded: t.is_backgrounded ?? a.backgrounded,
            state: 'working',
            endedAt: null,
          }),
        );
        return { ...started, bubble: bubble('handoff', t.description, t.subagent_type ?? null, now) ?? started.bubble };
      }
      case 'task_progress': {
        const t = m as Extract<SdkMsg, { subtype: 'task_progress' }>;
        const known = lane.agents.some((a) => a.taskId === t.task_id);
        if (!known && t.subagent_type === undefined) return lane;
        return upsertAgent(
          lane,
          t.task_id,
          () => newAgent(t.task_id, t.description, now),
          (a) => ({
            ...a,
            agentType: t.subagent_type ?? a.agentType,
            summary: t.summary ?? a.summary,
            lastTool: t.last_tool_name ?? a.lastTool,
            tokens: t.usage?.total_tokens ?? a.tokens,
          }),
        );
      }
      case 'task_updated': {
        const t = m as Extract<SdkMsg, { subtype: 'task_updated' }>;
        if (!lane.agents.some((a) => a.taskId === t.task_id)) return lane;
        const st = t.patch.status;
        const state =
          st === 'failed' ? 'failed' : st === 'killed' ? 'stopped' : st === 'completed' ? 'done' : 'working';
        return upsertAgent(
          lane,
          t.task_id,
          () => newAgent(t.task_id, '', now),
          (a) => ({
            ...a,
            state,
            description: t.patch.description ?? a.description,
            backgrounded: t.patch.is_backgrounded ?? a.backgrounded,
            endedAt: state === 'working' ? a.endedAt : (t.patch.end_time ?? now),
          }),
        );
      }
      case 'task_notification': {
        const t = m as Extract<SdkMsg, { subtype: 'task_notification' }>;
        const agent = lane.agents.find((a) => a.taskId === t.task_id);
        if (t.ambient || !agent) return lane;
        const state = t.status === 'completed' ? 'done' : t.status === 'failed' ? 'failed' : 'stopped';
        const ended = upsertAgent(
          lane,
          t.task_id,
          () => newAgent(t.task_id, '', now),
          (a) => ({ ...a, state, endedAt: now, summary: t.summary || a.summary }),
        );
        return {
          ...ended,
          bubble: bubble('returned', t.summary || agent.description, agent.agentType, now) ?? ended.bubble,
        };
      }
      case 'background_tasks_changed': {
        const t = m as Extract<SdkMsg, { subtype: 'background_tasks_changed' }>;
        const liveTasks = t.tasks.filter((x) => isAgentTask(x));
        const live = new Set(liveTasks.map((x) => x.task_id));
        // The set lists background tasks only, so it never ends a foreground agent.
        const agents = lane.agents.map((a): AgentNode => {
          if (live.has(a.taskId)) return a.backgrounded ? a : { ...a, backgrounded: true };
          return a.backgrounded && a.state === 'working' ? { ...a, state: 'done', endedAt: now } : a;
        });
        for (const x of liveTasks) {
          if (!agents.some((a) => a.taskId === x.task_id))
            agents.push({ ...newAgent(x.task_id, x.description, now), backgrounded: true });
        }
        return { ...lane, agents };
      }
      default:
        return lane;
    }
  }
  if (msg.type === 'assistant') {
    const a = msg as Extract<SdkMsg, { type: 'assistant' }>;
    if (a.error === 'cloud_credential_error') return { ...lane, status: 'error', error: 'cloud_credential_error' };
    if (a.parent_tool_use_id) return lane;
    // One API response arrives as one message per content block, all carrying the same usage.
    const id = a.message.id ?? null;
    const priced =
      id && id !== lane.pricedMessageId && a.message.usage
        ? {
            ...lane,
            pricedMessageId: id,
            inflightMainUsd: lane.inflightMainUsd + estimateUsd(a.message.usage, a.message.model ?? lane.model, rates),
          }
        : lane;
    // A conversation speaks its own words; every other lane speaks through post_status.
    if (lane.kind !== 'chat' && lane.kind !== 'review') return priced;
    const texts = a.message.content.filter((b) => b.type === 'text' && b.text);
    if (!texts.length) return priced;
    return { ...priced, bubble: bubble('said', texts[texts.length - 1].text ?? '', null, now) ?? lane.bubble };
  }
  if (msg.type === 'result') {
    const r = msg as Extract<SdkMsg, { type: 'result' }>;
    // The CLI's figure is exact for everything so far; the guess starts over from zero.
    const settled: Lane = {
      ...lane,
      inflightMainUsd: 0,
      pricedMessageId: null,
      costBasis: basisOf(r.modelUsage) ?? lane.costBasis,
      agents: lane.agents.map((a) => (a.tokens === a.settledTokens ? a : { ...a, settledTokens: a.tokens })),
    };
    if (r.subtype === 'success') {
      const s = r as Extract<SdkMsg, { subtype: 'success' }>;
      return { ...settled, costUsd: s.total_cost_usd, status: 'idle', error: null };
    }
    const e = r as { type: 'result'; subtype: string; total_cost_usd: number; errors?: string[] };
    return {
      ...settled,
      costUsd: e.total_cost_usd ?? lane.costUsd,
      status: 'error',
      error: (e.errors ?? []).join('; ') || r.subtype,
    };
  }
  return lane;
}
