import type { FeedEntry } from '../shared/types.ts';
import { withScreenshots } from './attachments.ts';

/** The subset of a transcript message the feed reads. Matches the SDK's SessionMessage shape. */
export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system';
  message: unknown;
  parent_tool_use_id?: string | null;
}

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

const MAX_RESULT = 400;
/** Long enough for a full review preview; the panel is where you read those. */
const MAX_TEXT = 12_000;

function base(p: unknown): string {
  return typeof p === 'string' ? p.split(/[\\/]/).pop() || p : '';
}

function str(v: unknown, max = 120): string {
  if (typeof v !== 'string') return '';
  const one = v.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One line a technician can read: the tool and the thing it touched. */
export function toolLine(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `${name} ${base(input.file_path ?? input.path ?? input.notebook_path)}`.trim();
    case 'Bash':
      return `Bash ${str(input.command, 100)}`.trim();
    case 'Grep':
      return `Grep ${str(input.pattern, 60)}${input.path ? ` in ${base(input.path)}` : ''}`.trim();
    case 'Glob':
      return `Glob ${str(input.pattern, 80)}`.trim();
    case 'Task':
    case 'Agent':
      return `${name} ${str(input.description ?? input.prompt, 100)}`.trim();
    case 'Skill':
      return `Skill ${str(input.skill ?? input.name, 60)}`.trim();
    case 'WebFetch':
      return `WebFetch ${str(input.url, 100)}`.trim();
    case 'WebSearch':
      return `WebSearch ${str(input.query, 100)}`.trim();
    case 'AskUserQuestion': {
      const qs = input.questions;
      const first = Array.isArray(qs) ? (qs[0] as { question?: string } | undefined)?.question : undefined;
      return `Ask ${str(first, 100)}`.trim();
    }
    case 'TodoWrite':
      return 'TodoWrite';
    default: {
      const firstString = Object.values(input).find((v) => typeof v === 'string');
      return `${name} ${str(firstString, 80)}`.trim();
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Turn transcript messages into a readable feed: assistant text, tool one-liners, collapsed results. */
export function toFeed(messages: TranscriptMessage[], toolNames: Map<string, string> = new Map()): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const msg = m.message as { content?: unknown; role?: string } | undefined;
    const content = msg?.content;
    if (typeof content === 'string') {
      const text = content.trim();
      if (!text || text.startsWith('<')) continue;
      if (m.type === 'user') out.push({ kind: 'user', text: text.slice(0, MAX_TEXT), tool: null });
      else out.push({ kind: 'text', text: text.slice(0, MAX_TEXT), tool: null });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const start = out.length;
    let shots = 0;
    for (const raw of content as Block[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type === 'image' && m.type === 'user') shots++;
      else if (raw.type === 'text' && raw.text) {
        const text = raw.text.trim();
        if (!text || text.startsWith('<')) continue;
        out.push({ kind: m.type === 'user' ? 'user' : 'text', text: text.slice(0, MAX_TEXT), tool: null });
      } else if (raw.type === 'tool_use' && raw.name) {
        const id = (raw as { id?: string }).id;
        if (id) toolNames.set(id, raw.name);
        out.push({ kind: 'tool', text: toolLine(raw.name, raw.input ?? {}), tool: raw.name });
      } else if (raw.type === 'tool_result') {
        const id = (raw as { tool_use_id?: string }).tool_use_id;
        const tool = (id && toolNames.get(id)) || null;
        const text = resultText(raw.content).trim();
        if (!text) continue;
        const clipped = text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT - 1)}…` : text;
        out.push({ kind: 'result', text: raw.is_error ? `error: ${clipped}` : clipped, tool });
      }
    }
    if (shots) noteScreenshots(out, start, shots);
  }
  return out;
}

/** Screenshots you sent show as a note on your words from that message, or on their own. */
function noteScreenshots(out: FeedEntry[], start: number, shots: number): void {
  const said = out.slice(start).find((e) => e.kind === 'user');
  if (said) said.text = withScreenshots(said.text, shots);
  else out.push({ kind: 'user', text: withScreenshots('', shots), tool: null });
}

/** Pick the subagent transcript id for a task id the SDK reported. */
export function matchAgentId(taskId: string, agentIds: string[]): string | null {
  if (agentIds.includes(taskId)) return taskId;
  const loose = agentIds.find((id) => id.endsWith(taskId) || taskId.endsWith(id) || id.includes(taskId));
  return loose ?? null;
}
