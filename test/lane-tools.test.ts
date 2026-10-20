import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbitServer } from '../src/main/decisions.ts';
import { boardTool, laneRules, laneTools, reviewTool, STATUS_MAX, type LaneSink } from '../src/main/lane-tools.ts';

/** A sink that records every call, and reports an open ask only after needs_you. */
function recorder() {
  const calls: Array<[string, string, unknown]> = [];
  let open = false;
  const sink: LaneSink = {
    needsYou: (laneId, ask) => {
      open = true;
      calls.push(['needsYou', laneId, ask]);
    },
    withdrawNeedsYou: (laneId) => {
      calls.push(['withdraw', laneId, open]);
      const was = open;
      open = false;
      return was;
    },
    postStatus: (laneId, line) => calls.push(['status', laneId, line]),
    reportBoard: (laneId, report) => calls.push(['board', laneId, report]),
    reviewPreview: (laneId, prompt) => calls.push(['review', laneId, prompt]),
  };
  return { sink, calls };
}

const callerFor = (tools: unknown[]) => {
  const reg = (
    orbitServer(tools) as unknown as {
      instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> };
    }
  ).instance._registeredTools;
  return async (name: string, args: Record<string, unknown>) => {
    assert.ok(reg[name], `${name} is registered`);
    return (await reg[name].handler(args, {})) as { isError?: boolean; content: Array<{ text: string }> };
  };
};

test('needs_you hands the question and its choices to the sink and tells the lane not to wait', async () => {
  const { sink, calls } = recorder();
  const call = callerFor(laneTools(sink, { id: 'shop', story: null }));
  const ok = await call('needs_you', {
    question: 'Close the nine stories that passed QA?',
    options: ['Close them', 'Leave them open'],
    story: '100204',
  });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /keep working/i);
  assert.deepEqual(calls, [
    [
      'needsYou',
      'shop',
      {
        question: 'Close the nine stories that passed QA?',
        options: ['Close them', 'Leave them open'],
        story: '100204',
      },
    ],
  ]);
});

test('needs_you tags a moon question with its story and refuses empty or oversized asks', async () => {
  const { sink, calls } = recorder();
  const call = callerFor(laneTools(sink, { id: 'story-1', story: '100233' }));
  await call('needs_you', { question: 'Merge it?' });
  assert.deepEqual(calls[0][2], { question: 'Merge it?', options: [], story: '100233' });

  const blank = await call('needs_you', { question: '   ' });
  assert.equal(blank.isError, true);
  const long = await call('needs_you', { question: 'Which?', options: ['x'.repeat(71), 'y'] });
  assert.equal(long.isError, true);
  assert.match(long.content[0].text, /option 1/);
  assert.equal(calls.length, 1, 'nothing refused reaches the sink');
});

test('withdraw_needs_you says whether there was anything to take back', async () => {
  const { sink } = recorder();
  const call = callerFor(laneTools(sink, { id: 'shop' }));
  assert.match((await call('withdraw_needs_you', {})).content[0].text, /nothing/i);
  await call('needs_you', { question: 'Merge it?' });
  assert.match((await call('withdraw_needs_you', {})).content[0].text, /withdrawn/i);
});

test('post_status takes one short line and refuses a paragraph', async () => {
  const { sink, calls } = recorder();
  const call = callerFor(laneTools(sink, { id: 'shop' }));
  await call('post_status', { line: '  Coupon-pick PR is up, two stories building.  ' });
  assert.deepEqual(calls[0], ['status', 'shop', 'Coupon-pick PR is up, two stories building.']);

  assert.equal((await call('post_status', { line: 'one\ntwo' })).isError, true);
  const long = await call('post_status', { line: 'x'.repeat(STATUS_MAX + 1) });
  assert.equal(long.isError, true);
  assert.match(long.content[0].text, new RegExp(String(STATUS_MAX)));
  assert.equal(calls.length, 1);
});

test('report_board passes the board through with empty lists for what was left out', async () => {
  const { sink, calls } = recorder();
  const call = callerFor([boardTool(sink, { id: 'shop' })]);
  await call('report_board', {
    shipped: ['100233 coupon pick'],
    inFlight: ['100234 gift box', '100150 size'],
    blocked: ['100166 waiting on Q19'],
    next: '100203 delivery form',
  });
  assert.deepEqual(calls[0], [
    'board',
    'shop',
    {
      shipped: ['100233 coupon pick'],
      inFlight: ['100234 gift box', '100150 size'],
      consults: [],
      drift: [],
      blocked: ['100166 waiting on Q19'],
      next: '100203 delivery form',
    },
  ]);
});

test('review_preview passes the numbered findings with the text to post, and an empty list for a clean PR', async () => {
  const { sink, calls } = recorder();
  const call = callerFor([reviewTool(sink, { id: 'review-7' })]);
  const finding = {
    n: 1,
    severity: 'major',
    file: 'a.ts',
    line: 48,
    gist: 'The flag check runs after the ERP call.',
    body: 'The flag check runs after the ERP call, so a disabled release still hits ERP. Move it above.',
  };
  const shown = await call('review_preview', { findings: [finding] });
  assert.match(shown.content[0].text, /Orbit posts the review/);
  await call('review_preview', { findings: [] });
  assert.deepEqual(calls, [
    ['review', 'review-7', { findings: [finding] }],
    ['review', 'review-7', { findings: [] }],
  ]);
});

test('laneRules tells every lane but a chat how Orbit hears it, with the tools its kind has', () => {
  assert.equal(laneRules('chat'), null);
  for (const kind of ['project', 'story', 'monitor', 'review'] as const) {
    const rules = laneRules(kind)!;
    assert.match(rules, /mcp__orbit__needs_you/, kind);
    assert.match(rules, /mcp__orbit__post_status/, kind);
    assert.match(rules, /never reaches them/, kind);
  }
  assert.match(laneRules('project')!, /mcp__orbit__report_board/);
  assert.doesNotMatch(laneRules('monitor')!, /report_board/);
  assert.match(laneRules('review')!, /mcp__orbit__review_preview/);
  assert.doesNotMatch(laneRules('review')!, /ask_product_owner/);
  assert.match(laneRules('story')!, /mcp__orbit__ask_product_owner/);
});

test('the lane rules and tools name whoever reads Orbit', async () => {
  const rules = laneRules('project', 'Pat') ?? '';
  assert.match(rules, /Orbit, Pat's desktop app\. Pat reads Orbit/);
  assert.doesNotMatch(rules, /\bhim\b|\bhis\b/);
  const { sink } = recorder();
  const tools = laneTools(sink, { id: 'shop' }, 'Pat') as Array<{ name: string; description: string }>;
  assert.match(tools.find((t) => t.name === 'needs_you')!.description, /Ask Pat for a call only they can make/);
  const review = reviewTool(sink, { id: 'r' }, 'Pat') as { description: string };
  assert.match(review.description, /Show Pat the comments/);
  assert.match(laneRules('project') ?? '', /the user reads Orbit/i, 'unnamed, it still reads');
});
