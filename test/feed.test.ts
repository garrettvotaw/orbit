import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFeed, toolLine, matchAgentId, type TranscriptMessage } from '../src/main/feed.ts';

test('toolLine reads like a clerk would say it', () => {
  assert.equal(toolLine('Edit', { file_path: 'C:/src/x/libs/a/shopper-step.spec.ts' }), 'Edit shopper-step.spec.ts');
  assert.equal(
    toolLine('Bash', { command: 'npx nx test wo-client   --watch=false' }),
    'Bash npx nx test wo-client --watch=false',
  );
  assert.equal(toolLine('Grep', { pattern: 'billingContact', path: 'C:/src/x/libs' }), 'Grep billingContact in libs');
  assert.equal(toolLine('Task', { description: 'angular lane', prompt: 'long…' }), 'Task angular lane');
  assert.equal(
    toolLine('AskUserQuestion', { questions: [{ question: 'Which Store code?' }] }),
    'Ask Which Store code?',
  );
  assert.equal(toolLine('mcp__ado__wit_work_item', { id: 'x', query: 'SELECT 1' }), 'mcp__ado__wit_work_item x');
});

test('toFeed turns a transcript into text, tool, and collapsed result entries', () => {
  const msgs: TranscriptMessage[] = [
    { type: 'user', message: { role: 'user', content: 'Run the Shop board.' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Deriving the board.' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'gh pr list' } },
        ],
      },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(600) }] },
    },
    { type: 'user', message: { role: 'user', content: '<system-reminder>ignored</system-reminder>' } },
    { type: 'system', message: {} },
  ];
  const feed = toFeed(msgs);
  assert.deepEqual(
    feed.map((f) => f.kind),
    ['user', 'text', 'tool', 'result'],
  );
  assert.equal(feed[2].text, 'Bash gh pr list');
  assert.equal(feed[3].tool, 'Bash');
  assert.ok(feed[3].text.length <= 400);
  assert.ok(feed[3].text.endsWith('…'));
});

test('a message you sent with screenshots reads as your words and a note of how many', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const feed = toFeed([
    { type: 'user', message: { role: 'user', content: [image, { type: 'text', text: 'this toast never clears' }] } },
    { type: 'user', message: { role: 'user', content: [image, image] } },
  ]);
  assert.deepEqual(feed, [
    { kind: 'user', text: 'this toast never clears\n[screenshot]', tool: null },
    { kind: 'user', text: '[2 screenshots]', tool: null },
  ]);
});

test('error results are marked', () => {
  const feed = toFeed([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'z', content: [{ type: 'text', text: 'boom' }], is_error: true }],
      },
    },
  ]);
  assert.equal(feed[0].text, 'error: boom');
  assert.equal(feed[0].tool, null);
});

test('matchAgentId prefers exact then loose matches', () => {
  const ids = ['aauth-1905-55ca8986eaf748f9', 'abloat-1905-c02af345b08f6c86'];
  assert.equal(matchAgentId('aauth-1905-55ca8986eaf748f9', ids), ids[0]);
  assert.equal(matchAgentId('55ca8986eaf748f9', ids), ids[0]);
  assert.equal(matchAgentId('nope', ids), null);
});
