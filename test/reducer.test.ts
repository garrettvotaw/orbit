import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceLane, errorCodeFor, gist, isAgentTask, pruneAgents, type SdkMsg } from '../src/main/reducer.ts';
import { AGENT_RETENTION_MS, emptyLane } from '../src/shared/types.ts';

const base = () => ({
  ...emptyLane({
    kind: 'project',
    id: 'shop',
    name: 'Shop',
    agent: 'shop-pm',
    cwd: 'c',
    ado: { org: 'o', project: 'p', anchorId: 1 },
    kickoff: 'go',
  }),
  status: 'starting' as const,
  startedAt: 1,
});
const sid = 'sess-1';
const init: SdkMsg = {
  type: 'system',
  subtype: 'init',
  session_id: sid,
  model: 'us.anthropic.claude-fable-5-1[1m]',
  uuid: 'u1',
} as SdkMsg;

test('init records session and model and goes working', () => {
  const l = reduceLane(base(), init, 10);
  assert.equal(l.sessionId, sid);
  assert.equal(l.model, 'us.anthropic.claude-fable-5-1[1m]');
  assert.equal(l.status, 'working');
});

test('task lifecycle builds the agent tree', () => {
  let l = reduceLane(base(), init, 10);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'tu1',
      description: 'angular lane',
      task_type: 'local_agent',
      spawn_depth: 1,
      session_id: sid,
      uuid: 'u2',
    } as SdkMsg,
    11,
  );
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'angular lane',
      subagent_type: 'angular',
      usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 500 },
      last_tool_name: 'Edit',
      summary: 'writing the spec',
      session_id: sid,
      uuid: 'u3',
    } as SdkMsg,
    12,
  );
  assert.equal(l.agents.length, 1);
  assert.equal(l.agents[0].agentType, 'angular');
  assert.equal(l.agents[0].summary, 'writing the spec');
  assert.equal(l.agents[0].lastTool, 'Edit');
  assert.equal(l.agents[0].tokens, 1200);
  assert.equal(l.agents[0].depth, 1);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      output_file: 'f',
      summary: 'done',
      session_id: sid,
      uuid: 'u4',
    } as SdkMsg,
    13,
  );
  assert.equal(l.agents[0].state, 'done');
  assert.equal(l.agents[0].endedAt, 13);
});

test('ambient tasks are ignored', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'amb',
      description: 'watch',
      ambient: true,
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  assert.equal(l.agents.length, 0);
});

test('task_updated failed and background_tasks_changed prune', () => {
  let l = reduceLane(base(), init, 1);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      description: 'a',
      task_type: 'local_agent',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 't2',
      description: 'b',
      task_type: 'local_agent',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'failed', error: 'boom' },
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    3,
  );
  assert.equal(l.agents.find((a) => a.taskId === 't1')!.state, 'failed');
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 't2', task_type: 'local_agent', description: 'b' }],
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    4,
  );
  assert.equal(l.agents.find((a) => a.taskId === 't1')!.state, 'failed', 'finished agents stay for fade-out');
  assert.equal(l.agents.find((a) => a.taskId === 't2')!.state, 'working');
});

test('session_state_changed drives status', () => {
  let l = reduceLane(base(), init, 1);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'requires_action',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  assert.equal(l.status, 'needs-you');
  l = reduceLane(
    l,
    { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sid, uuid: 'u' } as SdkMsg,
    3,
  );
  assert.equal(l.status, 'working');
  l = reduceLane(
    l,
    { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: sid, uuid: 'u' } as SdkMsg,
    4,
  );
  assert.equal(l.status, 'idle');
});

test('assistant text never sets lastSummary; only post_status does', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Deriving the board.\nSecond line.' }] },
      parent_tool_use_id: null,
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  assert.equal(l.lastSummary, null);
});

test('subagent assistant text does not touch lastSummary', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'inner' }] },
      parent_tool_use_id: 'tu9',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  assert.equal(l.lastSummary, null);
});

test('success result records cost and goes idle without reading a board out of the text', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 4.12,
      result: '## Shipped\n- 1 a\n## Blocked\n- 2 b needs a call\n## Next\n3 c',
      is_error: false,
      num_turns: 9,
      duration_ms: 1,
      duration_api_ms: 1,
      stop_reason: 'end_turn',
      usage: {},
      modelUsage: {},
      permission_denials: [],
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    50,
  );
  assert.equal(l.costUsd, 4.12);
  assert.equal(l.status, 'idle');
  assert.equal(l.lastReport, null);
});

test('error result goes error with message', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['Claude Code process exited with code 1'],
      total_cost_usd: 0.3,
      is_error: true,
      num_turns: 2,
      duration_ms: 1,
      duration_api_ms: 1,
      stop_reason: null,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    9,
  );
  assert.equal(l.status, 'error');
  assert.match(l.error!, /exited with code 1/);
  assert.equal(l.costUsd, 0.3);
});

test('errorCodeFor maps families', () => {
  assert.equal(errorCodeFor(['503 Service Unavailable from Bedrock'], 'error_during_execution'), 'api');
  assert.equal(errorCodeFor(['api_error: overloaded'], 'error_during_execution'), 'api');
  assert.equal(
    errorCodeFor(['cloud_credential_error: could not load AWS credentials'], 'error_during_execution'),
    'aws-sso',
  );
  assert.equal(errorCodeFor(['process exited'], 'error_during_execution'), 'exit');
});

test('background shell, workflow, and mcp tasks never become agents', () => {
  let l = reduceLane(base(), init, 1);
  for (const [id, task_type] of [
    ['b1', 'local_bash'],
    ['w1', 'local_workflow'],
    ['m1', 'mcp_task'],
  ]) {
    l = reduceLane(
      l,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: id,
        description: 'npx nx test',
        task_type,
        session_id: sid,
        uuid: 'u',
      } as SdkMsg,
      2,
    );
  }
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'b1',
      description: 'npx nx test',
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 },
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    3,
  );
  assert.equal(l.agents.length, 0);
  assert.equal(isAgentTask({ task_type: 'local_agent' }), true);
  assert.equal(isAgentTask({ task_type: 'in_process_teammate' }), true);
  assert.equal(isAgentTask({ spawn_depth: 1 }), true);
  assert.equal(isAgentTask({}), false);
});

test('task_started carries the agent type', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      description: 'review',
      task_type: 'local_agent',
      subagent_type: 'review-bloat',
      spawn_depth: 1,
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  assert.equal(l.agents[0].agentType, 'review-bloat');
});

test('finished agents are dropped after the retention window', () => {
  let l = reduceLane(base(), init, 1);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      description: 'x',
      task_type: 'local_agent',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a1',
      status: 'completed',
      summary: 'done',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    10,
  );
  assert.equal(l.agents.length, 1, 'kept right after finishing');
  l = reduceLane(
    l,
    { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sid, uuid: 'u' } as SdkMsg,
    10 + AGENT_RETENTION_MS,
  );
  assert.equal(l.agents.length, 1, 'kept at the edge of the window');
  l = reduceLane(
    l,
    { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sid, uuid: 'u' } as SdkMsg,
    11 + AGENT_RETENTION_MS,
  );
  assert.equal(l.agents.length, 0, 'gone after the window');
  assert.deepEqual(pruneAgents(l, 99), l, 'no-op returns the same lane');
});

test('background_tasks_changed adds live agent tasks the host never saw start', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'r1', task_type: 'local_agent', description: 'resumed' },
        { task_id: 'b1', task_type: 'local_bash', description: 'tests' },
      ],
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  assert.deepEqual(
    l.agents.map((a) => a.taskId),
    ['r1'],
  );
});

test('background_tasks_changed ends backgrounded agents and leaves foreground ones running', () => {
  const started = (task_id: string, is_backgrounded: boolean) =>
    ({
      type: 'system',
      subtype: 'task_started',
      task_id,
      description: task_id,
      subagent_type: 'qa-tester',
      task_type: 'local_agent',
      is_backgrounded,
      spawn_depth: 1,
      session_id: sid,
      uuid: 'u',
    }) as SdkMsg;
  let l = reduceLane(base(), init, 1);
  l = reduceLane(l, started('fg', false), 2);
  l = reduceLane(l, started('bg', true), 2);
  l = reduceLane(l, started('moved', false), 2);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'moved',
      patch: { is_backgrounded: true },
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    3,
  );
  // A subagent's background Bash run is the only live background task.
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'playwright' }],
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    4,
  );
  const state = (id: string) => l.agents.find((a) => a.taskId === id)?.state;
  assert.equal(state('fg'), 'working', 'a foreground agent is never in the background set');
  assert.equal(state('bg'), 'done');
  assert.equal(state('moved'), 'done');
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'fg',
      status: 'completed',
      summary: 'lane ok',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    5,
  );
  assert.equal(state('fg'), 'done');
});

test('an agent the background set lists ends when it leaves the set', () => {
  let l = reduceLane(base(), init, 1);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      description: 'a',
      task_type: 'local_agent',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  const level = (ids: string[]) =>
    ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: 'a' })),
      session_id: sid,
      uuid: 'u',
    }) as SdkMsg;
  l = reduceLane(l, level(['a1']), 3);
  l = reduceLane(l, level([]), 4);
  assert.equal(l.agents[0].state, 'done');
  assert.equal(l.agents[0].endedAt, 4);
});

test('gist keeps the first real line, drops markdown dressing, and caps the length', () => {
  assert.equal(gist('\n\n## Board\n\nDeriving the board.'), 'Board');
  assert.equal(gist('- **Shipped**: `two` lanes\nmore'), 'Shipped: two lanes');
  assert.equal(gist('---\n> quoted   text'), 'quoted text');
  assert.equal(gist('   \n  '), '');
  const long = gist('x'.repeat(200));
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
});

test('a PM bubble follows who it handed off to and got back, never its text', () => {
  let l = reduceLane(base(), init, 10);
  l = reduceLane(
    l,
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '## Plan\nTwo lanes to open this tick.' }] },
      parent_tool_use_id: null,
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    11,
  );
  assert.equal(l.bubble, null, 'a PM speaks through post_status, not its reply text');
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      description: 'type change clears steps',
      subagent_type: 'angular',
      task_type: 'local_agent',
      spawn_depth: 1,
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    12,
  );
  assert.deepEqual(l.bubble, { kind: 'handoff', text: 'type change clears steps', agentType: 'angular', at: 12 });
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'b1',
      description: 'npx nx test',
      task_type: 'local_bash',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    13,
  );
  assert.equal(l.bubble?.at, 12, 'plumbing tasks do not speak');
  l = reduceLane(
    l,
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'inner thoughts' }] },
      parent_tool_use_id: 'tu-sub',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    14,
  );
  assert.equal(l.bubble?.at, 12, 'subagent text does not speak for the PM');
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'Spec passes; 3 files changed.\nDetails follow.',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    15,
  );
  assert.deepEqual(l.bubble, { kind: 'returned', text: 'Spec passes; 3 files changed.', agentType: 'angular', at: 15 });
  l = reduceLane(
    l,
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   \n\n' }] },
      parent_tool_use_id: null,
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    16,
  );
  assert.equal(l.bubble?.at, 15, 'blank text keeps the last bubble');
});

test('a chat or review bubble shows the gist of what it last said', () => {
  const said = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: '## Plan\nTwo lanes to open this tick.' }] },
    parent_tool_use_id: null,
    session_id: sid,
    uuid: 'u',
  } as SdkMsg;
  for (const cfg of [
    { kind: 'chat' as const, id: 'ask', name: 'Ask', cwd: 'c' },
    { kind: 'review' as const, id: 'review-7', name: '#7', cwd: 'c', pr: 7, repo: 'o/r', url: 'u' },
  ]) {
    const l = reduceLane(reduceLane({ ...emptyLane(cfg), status: 'idle' as const }, init, 10), said, 11);
    assert.deepEqual(l.bubble, { kind: 'said', text: 'Plan', agentType: null, at: 11 }, cfg.kind);
    assert.equal(l.lastSummary, null, cfg.kind);
  }
});

test('the in-flight guess grows per priced API response and per agent token, then settles on the result', () => {
  const rates = { 'claude-fable-5-1': { perWeighted: 4e-6, perToken: 1e-6, basis: 'list' as const } };
  let l = reduceLane(base(), { ...init, model: 'claude-fable-5-1' } as SdkMsg, 10, rates);
  const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 };
  const reply = (id: string, text: string): SdkMsg =>
    ({
      type: 'assistant',
      message: { id, model: 'claude-fable-5-1', usage, content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: sid,
      uuid: 'u',
    }) as SdkMsg;
  l = reduceLane(l, reply('m1', 'one'), 11, rates);
  const perResponse = 4e-6 * (100 + 100 + 100);
  assert.ok(Math.abs(l.costInflightUsd - perResponse) < 1e-12);
  l = reduceLane(l, reply('m1', 'same response, next content block'), 12, rates);
  assert.ok(Math.abs(l.costInflightUsd - perResponse) < 1e-12, 'one API response is priced once');
  l = reduceLane(l, reply('m2', 'two'), 13, rates);
  assert.ok(Math.abs(l.costInflightUsd - 2 * perResponse) < 1e-12);
  l = reduceLane(
    l,
    {
      type: 'assistant',
      message: { id: 'sub', model: 'claude-fable-5-1', usage, content: [{ type: 'text', text: 'inner' }] },
      parent_tool_use_id: 'tu-sub',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    14,
    rates,
  );
  assert.ok(Math.abs(l.costInflightUsd - 2 * perResponse) < 1e-12, 'subagent text is not the main loop');
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      description: 'fix',
      subagent_type: 'angular',
      task_type: 'local_agent',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    15,
    rates,
  );
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'fix',
      usage: { total_tokens: 50_000, tool_uses: 1, duration_ms: 1 },
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    16,
    rates,
  );
  assert.ok(Math.abs(l.costInflightUsd - (2 * perResponse + 0.05)) < 1e-12, 'agent tokens at the average rate');
  l = reduceLane(
    l,
    {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 1.25,
      result: 'done',
      modelUsage: {},
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    17,
    rates,
  );
  assert.equal(l.costUsd, 1.25);
  assert.equal(l.costInflightUsd, 0);
  assert.equal(l.agents[0].settledTokens, 50_000);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'fix',
      usage: { total_tokens: 60_000, tool_uses: 2, duration_ms: 2 },
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    18,
    rates,
  );
  assert.ok(Math.abs(l.costInflightUsd - 0.01) < 1e-12, 'only tokens since the settlement count');
});

test('a result records which price table the CLI used', () => {
  const l = reduceLane(
    reduceLane(base(), init, 1),
    {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.5,
      result: 'ok',
      modelUsage: {
        m: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.5,
          costBasis: 'unknown',
        },
      },
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    2,
  );
  assert.equal(l.costBasis, 'unknown');
  assert.equal(reduceLane(base(), init, 1).costBasis, null);
});

test('an unsettled agent outlives the retention window while the lane is still working', () => {
  const rates = { 'claude-fable-5-1': { perWeighted: 4e-6, perToken: 1e-6, basis: 'list' as const } };
  let l = reduceLane(base(), { ...init, model: 'claude-fable-5-1' } as SdkMsg, 10, rates);
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      description: 'd',
      subagent_type: 'angular',
      task_type: 'local_agent',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    11,
    rates,
  );
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'd',
      usage: { total_tokens: 1000, tool_uses: 1, duration_ms: 1 },
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    12,
    rates,
  );
  l = reduceLane(
    l,
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'ok',
      session_id: sid,
      uuid: 'u',
    } as SdkMsg,
    13,
    rates,
  );
  l = reduceLane(
    l,
    { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sid, uuid: 'u' } as SdkMsg,
    13 + AGENT_RETENTION_MS + 1,
    rates,
  );
  assert.equal(l.agents.length, 1, 'kept: its tokens are not yet in an exact figure');
  assert.ok(Math.abs(l.costInflightUsd - 0.001) < 1e-12);
  l = reduceLane(
    l,
    { type: 'result', subtype: 'success', total_cost_usd: 1, result: 'done', session_id: sid, uuid: 'u' } as SdkMsg,
    14 + AGENT_RETENTION_MS,
    rates,
  );
  assert.equal(l.agents.length, 0, 'settled and past the window, so gone');
});
