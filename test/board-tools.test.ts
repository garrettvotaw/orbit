import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardTools, boardToolsFor, type BoardAccess } from '../src/main/board-tools.ts';
import { orbitServer } from '../src/main/decisions.ts';
import { laneRules } from '../src/main/lane-tools.ts';
import { TrackerMoveError, type StoryDetail, type Tracker } from '../src/main/trackers/tracker.ts';
import type { BoardColumn, LaneConfig, OrbitConfig, TrackerBoard, TrackerItem } from '../src/shared/types.ts';

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

const item = (
  id: string,
  stage: TrackerItem['stage'],
  column: string,
  extra: Partial<TrackerItem> = {},
): TrackerItem => ({
  id,
  key: id.startsWith('ACME') ? id : `#${id}`,
  title: `story ${id}`,
  type: 'Story',
  column,
  stage,
  assignedTo: null,
  parentId: null,
  prs: [],
  url: `https://tracker/${id}`,
  sprint: null,
  ...extra,
});
const columns: BoardColumn[] = [
  { name: 'To Do', stage: 'not-started', color: '#1' },
  { name: 'Code Review', stage: 'in-review', color: '#2' },
];
const board = (items: TrackerItem[]): TrackerBoard => ({
  projectId: 'shop',
  tracker: { kind: 'github', site: 'github.com' },
  fetchedAt: 1,
  columns,
  items,
  stale: false,
  error: null,
});

function access(tracker: Partial<Tracker> | null, items: TrackerItem[] = []) {
  const calls: string[] = [];
  const a: BoardAccess = {
    tracker: (id) => (id === 'shop' && tracker ? (tracker as Tracker) : null),
    board: (id) => (id === 'shop' ? board(items) : null),
    refresh: async (id) => {
      calls.push(`refresh ${id}`);
    },
  };
  return { a, calls };
}

test('list_board formats each item and filters by stage', async () => {
  const items = [
    item('45', 'not-started', 'To Do', { assignedTo: 'pat' }),
    item('46', 'in-review', 'Code Review', {
      prs: [
        { repo: null, number: 41 },
        { repo: null, number: 42 },
      ],
    }),
  ];
  const call = callerFor(boardTools(access({}, items).a, { projectId: 'shop' }));
  const all = await call('list_board', {});
  assert.equal(
    all.content[0].text,
    [
      '#45 · not-started (To Do) · story 45 · pat · no PRs',
      '#46 · in-review (Code Review) · story 46 · unassigned · PRs #41, #42',
    ].join('\n'),
  );
  const review = await call('list_board', { stage: 'in-review' });
  assert.equal(review.content[0].text, '#46 · in-review (Code Review) · story 46 · unassigned · PRs #41, #42');
  assert.match((await call('list_board', { stage: 'done' })).content[0].text, /No stories .*done/);
});

test('move_story moves, refreshes that project board, and reports the column', async () => {
  const moved: unknown[] = [];
  const tracker: Partial<Tracker> = {
    move: async (id, stage, note) => {
      moved.push([id, stage, note]);
      return columns[1];
    },
  };
  const { a, calls } = access(tracker, [item('46', 'not-started', 'To Do')]);
  const res = await callerFor(boardTools(a, { projectId: 'shop' }))('move_story', {
    id: '46',
    stage: 'in-review',
    note: 'PR #41 is up',
  });
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, 'Moved #46 to Code Review (in-review).');
  assert.deepEqual(moved, [['46', 'in-review', 'PR #41 is up']]);
  assert.deepEqual(calls, ['refresh shop']);
});

test('move_story with no reachable column returns isError with the board columns and calls nothing else', async () => {
  const tracker: Partial<Tracker> = {
    move: async () => {
      throw new TrackerMoveError(
        'No column on this board is "testing". Its columns: To Do (not-started), Code Review (in-review)',
      );
    },
  };
  const { a, calls } = access(tracker);
  const res = await callerFor(boardTools(a, { projectId: 'shop' }))('move_story', { id: '46', stage: 'testing' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Its columns: To Do \(not-started\), Code Review \(in-review\)/);
  assert.deepEqual(calls, [], 'no refresh after a refused move');
});

test('get_story renders description, acceptance, comments, children, and links', async () => {
  const detail: StoryDetail = {
    item: item('ACME-1', 'building', 'In Progress'),
    description: 'Show every saved card.',
    acceptance: 'One\nTwo',
    comments: [{ author: 'Pat Doe', at: Date.parse('2026-10-02T10:00:00Z'), text: 'Looks good' }],
    children: [item('ACME-7', 'not-started', 'To Do')],
    links: [{ title: 'blocks ACME-9', url: 'https://tracker/ACME-9' }],
  };
  const { a } = access({ story: async () => detail });
  const text = (await callerFor(boardTools(a, { projectId: 'shop' }))('get_story', { id: 'ACME-1' })).content[0].text;
  for (const part of [
    'ACME-1 · story ACME-1',
    'building (In Progress) · https://tracker/ACME-1',
    'Description:\nShow every saved card.',
    'Acceptance criteria:\nOne\nTwo',
    '- Pat Doe (2026-10-02): Looks good',
    '- ACME-7 · not-started (To Do) · story ACME-7',
    '- blocks ACME-9: https://tracker/ACME-9',
  ])
    assert.ok(text.includes(part), part);
});

test('comment_on_story comments and names the story', async () => {
  const said: unknown[] = [];
  const { a } = access({ comment: async (id, t) => void said.push([id, t]) }, [item('46', 'not-started', 'To Do')]);
  const res = await callerFor(boardTools(a, { projectId: 'shop' }))('comment_on_story', { id: '46', text: 'hi' });
  assert.equal(res.content[0].text, 'Commented on #46.');
  assert.deepEqual(said, [['46', 'hi']]);
});

const cfgWith = (over: Partial<OrbitConfig> = {}): OrbitConfig => ({
  projects: [],
  monitors: [],
  chats: [],
  morning: [],
  alerts: { toast: true, sound: false },
  adoPollMinutes: 2,
  ...over,
});
const lane = (kind: LaneConfig['kind'], id: string) => ({ kind, id }) as unknown as LaneConfig;

test('boardToolsFor gives a project lane and its story lane the four tools, and nothing to anyone else', () => {
  const { a } = access({});
  const parentOf = (id: string) => (id === 'story-shop-46' ? 'shop' : id === 'story-plain-1' ? 'plain' : null);
  const names = (tools: unknown[]) => tools.map((t) => (t as { name: string }).name).sort();
  const four = ['comment_on_story', 'get_story', 'list_board', 'move_story'];
  assert.deepEqual(names(boardToolsFor(lane('project', 'shop'), cfgWith(), a, parentOf)), four);
  assert.deepEqual(names(boardToolsFor(lane('story', 'story-shop-46'), cfgWith(), a, parentOf)), four);
  for (const l of [lane('chat', 'shop'), lane('monitor', 'shop'), lane('review', 'shop'), lane('project', 'plain')])
    assert.deepEqual(boardToolsFor(l, cfgWith(), a, parentOf), [], `${l.kind} ${l.id}`);
  assert.deepEqual(boardToolsFor(lane('story', 'story-plain-1'), cfgWith(), a, parentOf), []);
  assert.deepEqual(boardToolsFor(lane('project', 'shop'), cfgWith({ boardTools: false }), a, parentOf), []);
});

test('no board tool appears in the rules every lane gets', () => {
  for (const kind of ['project', 'story'] as const) {
    const rules = laneRules(kind) ?? '';
    for (const name of ['list_board', 'get_story', 'move_story', 'comment_on_story'])
      assert.ok(!rules.includes(name), `${kind} rules mention ${name}`);
  }
});
