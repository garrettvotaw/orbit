import { getSessionMessages, getSubagentMessages, listSubagents } from '@anthropic-ai/claude-agent-sdk';
import type { FeedResponse } from '../shared/ipc.ts';
import type { FeedEntry, Lane } from '../shared/types.ts';
import { matchAgentId, toFeed, type TranscriptMessage } from './feed.ts';

const MAX_ENTRIES = 300;

/** Reads a PM's or a subagent's transcript through the SDK and shapes it into a feed. */
export class FeedReader {
  /**
   * `live` is the lane's in-memory feed while its session is running (even when still empty);
   * pass null for a stopped lane so the transcript on disk is used instead.
   */
  async read(
    lane: Lane | undefined,
    cwd: string | undefined,
    agentId: string | null,
    live: FeedEntry[] | null,
  ): Promise<FeedResponse> {
    if (agentId === null && live) {
      return {
        entries: live.slice(-MAX_ENTRIES),
        note: live.length
          ? null
          : lane?.kind === 'chat'
            ? 'Say something to start the conversation.'
            : 'Waiting for the first message.',
      };
    }
    if (!lane?.sessionId) {
      return { entries: [], note: lane?.kind === 'chat' ? 'Start the lane, then say something.' : 'No session yet.' };
    }
    const sessionId = lane.sessionId;
    try {
      if (agentId === null) {
        const messages = await withDirFallback((dir) => getSessionMessages(sessionId, { dir }), cwd);
        return finish(messages, 'The transcript is empty so far.');
      }
      const ids = await withDirFallback((dir) => listSubagents(sessionId, { dir }), cwd);
      const match = matchAgentId(agentId, ids);
      if (!match) return { entries: [], note: 'No transcript for this agent yet.' };
      const messages = await withDirFallback((dir) => getSubagentMessages(sessionId, match, { dir }), cwd);
      return finish(messages, 'The agent has not written anything yet.');
    } catch (e) {
      return { entries: [], note: `Could not read the transcript: ${(e as Error).message}` };
    }
  }
}

async function withDirFallback<T>(
  fn: (dir: string | undefined) => Promise<T[]>,
  cwd: string | undefined,
): Promise<T[]> {
  const scoped = cwd ? await fn(cwd) : [];
  return scoped.length ? scoped : fn(undefined);
}

function finish(messages: unknown[], emptyNote: string): FeedResponse {
  const entries = toFeed(messages as TranscriptMessage[]).slice(-MAX_ENTRIES);
  return { entries, note: entries.length ? null : emptyNote };
}
