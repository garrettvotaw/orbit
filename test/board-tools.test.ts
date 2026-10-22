import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { boardTools, boardToolsFor, type BoardAccess } from '../src/main/board-tools.ts';
import { orbitServer } from '../src/main/decisions.ts';
import { laneRules } from '../src/main/lane-tools.ts';
import {
  TrackerMoveError,
  TrackerUnsupportedError,
  type StoryDetail,
  type Tracker,
} from '../src/main/trackers/tracker.ts';
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
    move: async (id, stage, opts) => {
      moved.push([id, stage, opts]);
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
  assert.deepEqual(moved, [['46', 'in-review', { note: 'PR #41 is up', column: undefined, assignToMe: undefined }]]);
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
    reproSteps: null,
    parent: null,
    related: [],
    attachments: [],
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
  const { a } = access({ comment: async (id, t) => (said.push([id, t]), 'posted') }, [
    item('46', 'not-started', 'To Do'),
  ]);
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

test('boardToolsFor gives a project lane and its story lane the board tools, and nothing to anyone else', () => {
  const { a } = access({});
  const parentOf = (id: string) => (id === 'story-shop-46' ? 'shop' : id === 'story-plain-1' ? 'plain' : null);
  const names = (tools: unknown[]) => tools.map((t) => (t as { name: string }).name).sort();
  const all = [
    'attach_to_story',
    'comment_on_story',
    'get_attachment',
    'get_story',
    'link_stories',
    'list_board',
    'move_story',
  ];
  assert.deepEqual(names(boardToolsFor(lane('project', 'shop'), cfgWith(), a, parentOf)), all);
  assert.deepEqual(names(boardToolsFor(lane('story', 'story-shop-46'), cfgWith(), a, parentOf)), all);
  for (const l of [lane('chat', 'shop'), lane('monitor', 'shop'), lane('review', 'shop'), lane('project', 'plain')])
    assert.deepEqual(boardToolsFor(l, cfgWith(), a, parentOf), [], `${l.kind} ${l.id}`);
  assert.deepEqual(boardToolsFor(lane('story', 'story-plain-1'), cfgWith(), a, parentOf), []);
  assert.deepEqual(boardToolsFor(lane('project', 'shop'), cfgWith({ boardTools: false }), a, parentOf), []);
});

test('no board tool appears in the rules every lane gets', () => {
  for (const kind of ['project', 'story'] as const) {
    const rules = laneRules(kind) ?? '';
    for (const name of [
      'list_board',
      'get_story',
      'get_attachment',
      'move_story',
      'comment_on_story',
      'link_stories',
      'attach_to_story',
    ])
      assert.ok(!rules.includes(name), `${kind} rules mention ${name}`);
  }
});

test('move_story passes a column and assignToMe through and reports the column it landed in', async () => {
  const moved: unknown[] = [];
  const tracker: Partial<Tracker> = {
    move: async (id, stage, opts) => {
      moved.push([id, stage, opts]);
      return { name: 'Owner Review', stage: 'in-review', color: '#3' };
    },
  };
  const { a } = access(tracker, [item('46', 'testing', 'QA')]);
  const res = await callerFor(boardTools(a, { projectId: 'shop' }))('move_story', {
    id: '46',
    stage: 'in-review',
    column: 'Owner Review',
    assignToMe: true,
  });
  assert.equal(res.content[0].text, 'Moved #46 to Owner Review (in-review).');
  assert.deepEqual(moved, [['46', 'in-review', { column: 'Owner Review', note: undefined, assignToMe: true }]]);
});

test('get_story prints repro steps, the parent, related items, and attachments, and leaves out empty sections', async () => {
  const base: StoryDetail = {
    item: item('ACME-1', 'building', 'In Progress'),
    description: 'Show every saved card.',
    acceptance: null,
    comments: [],
    children: [],
    links: [],
    reproSteps: null,
    parent: null,
    related: [],
    attachments: [],
  };
  const full: StoryDetail = {
    ...base,
    reproSteps: 'Open checkout',
    parent: { item: item('ACME-120', 'building', 'In Progress'), description: 'Pay faster.', acceptance: 'One tap.' },
    related: [{ kind: 'blocked-by', item: item('ACME-9', 'not-started', 'To Do') }],
    attachments: [{ name: 'trace.txt', url: 'https://tracker/trace.txt' }],
  };
  const read = async (d: StoryDetail) =>
    (
      await callerFor(boardTools(access({ story: async () => d }).a, { projectId: 'shop' }))('get_story', {
        id: 'ACME-1',
      })
    ).content[0].text;
  const text = await read(full);
  for (const part of [
    'Repro steps:\nOpen checkout',
    'Parent:\nACME-120 · building (In Progress) · story ACME-120\nOne tap.',
    'Related:\n- blocked-by ACME-9 · not-started (To Do) · story ACME-9',
    'Attachments:\n- trace.txt',
  ])
    assert.ok(text.includes(part), part);
  const bare = await read(base);
  for (const heading of ['Repro steps:', 'Parent:', 'Related:', 'Attachments:'])
    assert.ok(!bare.includes(heading), heading);
});

test('get_attachment returns an image as image content, text as text, and says when it cannot show a file', async () => {
  const files: Record<string, { mimeType: string; data: Uint8Array }> = {
    'shot.png': { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) },
    'trace.txt': { mimeType: 'text/plain', data: new TextEncoder().encode('boom') },
    'logs.zip': { mimeType: 'application/zip', data: new Uint8Array(10) },
  };
  const tracker: Partial<Tracker> = {
    attachment: async (_id, name) => ({ name, ...files[name], size: files[name].data.length }),
  };
  const call = callerFor(boardTools(access(tracker).a, { projectId: 'shop' }));
  const image = (await call('get_attachment', { id: '46', name: 'shot.png' })) as unknown as {
    content: Array<{ type: string; data?: string; mimeType?: string }>;
  };
  assert.deepEqual(image.content[0], {
    type: 'image',
    data: Buffer.from([1, 2, 3]).toString('base64'),
    mimeType: 'image/png',
  });
  assert.equal((await call('get_attachment', { id: '46', name: 'trace.txt' })).content[0].text, 'boom');
  assert.equal(
    (await call('get_attachment', { id: '46', name: 'logs.zip' })).content[0].text,
    "logs.zip is application/zip, 10 bytes; Orbit can't show it here.",
  );
});

test('get_attachment passes a tracker refusal back as an error', async () => {
  const tracker: Partial<Tracker> = {
    attachment: async () => {
      throw new TrackerUnsupportedError(
        'GitHub keeps files inline in the issue text; read the links in its description.',
      );
    },
  };
  const res = await callerFor(boardTools(access(tracker).a, { projectId: 'shop' }))('get_attachment', {
    id: '3',
    name: 'x',
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /inline/);
});

test('comment_on_story with a marker says it updated that comment, or that it commented when it posted', async () => {
  const said: unknown[] = [];
  let result: 'posted' | 'updated' = 'updated';
  const tracker: Partial<Tracker> = {
    comment: async (id, text, opts) => {
      said.push([id, text, opts]);
      return result;
    },
  };
  const { a } = access(tracker, [item('46', 'not-started', 'To Do')]);
  const call = callerFor(boardTools(a, { projectId: 'shop' }));
  const updated = await call('comment_on_story', { id: '46', text: 'Plan v2', marker: 'plan' });
  assert.equal(updated.content[0].text, 'Updated the plan comment on #46.');
  result = 'posted';
  const posted = await call('comment_on_story', { id: '46', text: 'Plan v1', marker: 'plan' });
  assert.equal(posted.content[0].text, 'Commented on #46.');
  assert.deepEqual(said[0], ['46', 'Plan v2', { marker: 'plan' }]);
});

test('comment_on_story says when the tracker dropped the marker, so the next one will be new', async () => {
  const { a } = access({ comment: async () => 'unmarked' }, [item('46', 'not-started', 'To Do')]);
  const res = await callerFor(boardTools(a, { projectId: 'shop' }))('comment_on_story', {
    id: '46',
    text: 'Plan v1',
    marker: 'plan',
  });
  assert.equal(
    res.content[0].text,
    'Commented on #46, but the tracker dropped the hidden "plan" marker, so the next "plan" comment will be a new one.',
  );
});

test('comment_on_story takes a marker only of letters, digits, dots, dashes, and underscores', () => {
  const t = boardTools(access({}).a, { projectId: 'shop' }).find(
    (x) => (x as { name: string }).name === 'comment_on_story',
  ) as { inputSchema: z.ZodRawShape };
  const parse = (marker: string) => z.object(t.inputSchema).safeParse({ id: '46', text: 'hi', marker }).success;
  assert.equal(parse('plan.v2_final-1'), true);
  assert.equal(parse('plan --> shown'), false);
  assert.equal(parse(''), false);
});

test('link_stories links two stories and says how', async () => {
  const linked: unknown[] = [];
  const tracker: Partial<Tracker> = {
    ref: { kind: 'ado', site: 'contoso' },
    link: async (...args) => void linked.push(args),
  };
  const { a } = access(tracker, [item('46', 'not-started', 'To Do'), item('12', 'building', 'Doing')]);
  const call = callerFor(boardTools(a, { projectId: 'shop' }));
  const reply = async (kind: string) => (await call('link_stories', { id: '46', otherId: '12', kind })).content[0].text;
  assert.equal(await reply('blocks'), 'Linked #46 blocks #12.');
  assert.equal(await reply('duplicate'), 'Linked #46 duplicates #12.');
  assert.equal(await reply('related'), 'Linked #46 relates to #12.');
  assert.deepEqual(linked, [
    ['46', '12', 'blocks'],
    ['46', '12', 'duplicate'],
    ['46', '12', 'related'],
  ]);
});

test('link_stories on GitHub says the link is a comment, and that a duplicate was closed', async () => {
  const tracker: Partial<Tracker> = { ref: { kind: 'github', site: 'github.com' }, link: async () => {} };
  const { a } = access(tracker, [item('46', 'not-started', 'To Do'), item('12', 'building', 'Doing')]);
  const call = callerFor(boardTools(a, { projectId: 'shop' }));
  const reply = async (kind: string) => (await call('link_stories', { id: '46', otherId: '12', kind })).content[0].text;
  assert.equal(
    await reply('duplicate'),
    'Linked #46 duplicates #12. On GitHub that is a "Duplicate of #12" comment on #46, and #46 is closed as a duplicate.',
  );
  assert.equal(
    await reply('blocks'),
    'Linked #46 blocks #12. On GitHub that is a comment on #46 naming #12, which shows as a cross-reference.',
  );
});

test('attach_to_story reads the file from the lane folder and names the story', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-attach-'));
  try {
    writeFileSync(join(dir, 'trace.txt'), 'boom');
    const got: unknown[] = [];
    const tracker: Partial<Tracker> = {
      attach: async (id, f) => {
        got.push([id, f.name, new TextDecoder().decode(f.data)]);
        return { name: f.name, url: 'https://tracker/files/1' };
      },
    };
    const { a } = access(tracker, [item('46', 'not-started', 'To Do')]);
    const call = callerFor(boardTools(a, { projectId: 'shop', cwd: dir }));
    const res = await call('attach_to_story', { id: '46', path: 'trace.txt' });
    assert.equal(res.content[0].text, 'Attached trace.txt to #46.');
    assert.deepEqual(got, [['46', 'trace.txt', 'boom']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attach_to_story refuses a missing file, a folder, or one over 20 MB, and sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-attach-'));
  try {
    const big = join(dir, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 20 * 1024 * 1024 + 1);
    let calls = 0;
    const tracker: Partial<Tracker> = {
      attach: async () => {
        calls++;
        return { name: 'x', url: 'u' };
      },
    };
    const call = callerFor(boardTools(access(tracker).a, { projectId: 'shop', cwd: dir }));
    const missing = await call('attach_to_story', { id: '46', path: 'nope.txt' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /^No file at .*nope\.txt\.$/);
    const folder = await call('attach_to_story', { id: '46', path: '.' });
    assert.equal(folder.isError, true);
    assert.match(folder.content[0].text, / is a folder, not a file\.$/);
    const tooBig = await call('attach_to_story', { id: '46', path: big });
    assert.equal(tooBig.isError, true);
    assert.match(tooBig.content[0].text, /^big\.bin is over 20 MB \(20971521 bytes\)/);
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chat that names a project gets that project's board tools, and a chat that names none gets none", async () => {
  const { a } = access({}, [item('45', 'not-started', 'To Do')]);
  const chat = (project?: string) =>
    ({ kind: 'chat', id: 'helper', name: 'Helper', cwd: 'C:/tmp', ...(project ? { project } : {}) }) as LaneConfig;
  const names = (tools: unknown[]) => tools.map((t) => (t as { name: string }).name).sort();
  const tools = boardToolsFor(chat('shop'), cfgWith(), a, () => null);
  assert.deepEqual(names(tools), [
    'attach_to_story',
    'comment_on_story',
    'get_attachment',
    'get_story',
    'link_stories',
    'list_board',
    'move_story',
  ]);
  const listed = await callerFor(tools)('list_board', {});
  assert.match(listed.content[0].text, /^#45 · not-started \(To Do\)/, "it reads the project's board");
  assert.deepEqual(
    boardToolsFor(chat(), cfgWith(), a, () => null),
    [],
  );
  assert.deepEqual(
    boardToolsFor(chat('plain'), cfgWith(), a, () => null),
    [],
    'a project with no tracker lends none',
  );
  assert.deepEqual(
    boardToolsFor(chat('shop'), cfgWith({ boardTools: false }), a, () => null),
    [],
  );
});

test('get_attachment shows the first 64 KB of a long text file and says it was cut', async () => {
  const data = new TextEncoder().encode('x'.repeat(100 * 1024));
  const tracker: Partial<Tracker> = {
    attachment: async (_id, name) => ({ name, mimeType: 'text/plain', data, size: data.length }),
  };
  const res = await callerFor(boardTools(access(tracker).a, { projectId: 'shop' }))('get_attachment', {
    id: '46',
    name: 'build.log',
  });
  const text = res.content[0].text;
  assert.equal(text.indexOf('\n'), 64 * 1024, 'the first 64 KB, then the note');
  assert.ok(text.endsWith('\n\n[Orbit showed the first 64 KB of build.log, which is 102400 bytes.]'), text.slice(-90));
});

test("get_attachment names a file it only read the start of, and won't show a cut-off image", async () => {
  const head = new Uint8Array(5 * 1024 * 1024);
  const files: Record<string, { mimeType: string; size: number | null }> = {
    'dump.zip': { mimeType: 'application/zip', size: 314572800 },
    'huge.png': { mimeType: 'image/png', size: null },
  };
  const tracker: Partial<Tracker> = { attachment: async (_id, name) => ({ name, data: head, ...files[name] }) };
  const call = callerFor(boardTools(access(tracker).a, { projectId: 'shop' }));
  const reply = async (name: string) => (await call('get_attachment', { id: '46', name })).content[0];
  assert.equal(
    (await reply('dump.zip')).text,
    "dump.zip is application/zip, 314572800 bytes; Orbit can't show it here.",
  );
  assert.equal((await reply('huge.png')).text, "huge.png is image/png, over 5 MB; Orbit can't show it here.");
});
