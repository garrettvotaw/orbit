import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FetchLike } from '../src/main/trackers/ado.ts';
import { JiraAdapter, JiraClient, jiraJql } from '../src/main/trackers/jira.ts';
import { TrackerAuthError, TrackerMoveError } from '../src/main/trackers/tracker.ts';
import type { JiraTrackerConfig } from '../src/shared/types.ts';

const site = 'contoso.atlassian.net';
const cfg: JiraTrackerConfig = { kind: 'jira', site, projectKey: 'ACME', board: 42, epic: 'ACME-120' };
const creds = () => ({ email: 'pat@contoso.test', token: 't0k' });

interface Sent {
  method: string;
  path: string;
  auth?: string;
  body: unknown;
}
type Handler = (body: unknown, path: string) => { status: number; json: unknown };

/** Routes on method plus the start of the path (query string included); records every request. */
function jira(table: Array<[string, string, Handler]>) {
  const sent: Sent[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const p = url.replace(`https://${site}`, '');
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    sent.push({ method: init.method, path: p, auth: init.headers.Authorization, body });
    const hit = table.find(([m, prefix]) => m === init.method && p.startsWith(prefix));
    const r = hit ? hit[2](body, p) : { status: 404, json: { errorMessages: [`no route ${init.method} ${p}`] } };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    };
  };
  return { fetchFn, sent };
}

const issue = (n: number, statusId: string, statusName = 'Status') => ({
  key: `ACME-${n}`,
  fields: {
    summary: `story ${n}`,
    status: { id: statusId, name: statusName },
    issuetype: { name: 'Story' },
    assignee: n % 2 ? { displayName: 'Pat Doe' } : null,
    parent: { key: 'ACME-120' },
    customfield_10020: [{ name: 'Sprint 13' }, { name: 'Sprint 14' }],
  },
});

const boardConfig = {
  columnConfig: {
    columns: [
      { name: 'To Do', statuses: [{ id: '1' }] },
      { name: 'In Progress', statuses: [{ id: '3' }] },
      { name: 'Code Review', statuses: [{ id: '10001' }, { id: '10002' }] },
      { name: 'Done', statuses: [{ id: '10003' }] },
    ],
  },
};
const statuses = [
  { id: '1', statusCategory: { key: 'new' } },
  { id: '3', statusCategory: { key: 'indeterminate' } },
  { id: '10001', statusCategory: { key: 'indeterminate' } },
  { id: '10002', statusCategory: { key: 'indeterminate' } },
  { id: '10003', statusCategory: { key: 'done' } },
];
const sprintField = [{ id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }];

const boardRoutes = (issues: unknown[][] = [[issue(1, '1'), issue(2, '10002')]]): Array<[string, string, Handler]> => [
  ['GET', '/rest/agile/1.0/board/42/configuration', () => ({ status: 200, json: boardConfig })],
  ['GET', '/rest/api/3/status', () => ({ status: 200, json: statuses })],
  ['GET', '/rest/api/3/field', () => ({ status: 200, json: sprintField })],
  [
    'POST',
    '/rest/api/3/search/jql',
    (body) => {
      const page = Number((body as { nextPageToken?: string }).nextPageToken ?? 0);
      const last = page === issues.length - 1;
      return {
        status: 200,
        json: { issues: issues[page], isLast: last, ...(last ? {} : { nextPageToken: String(page + 1) }) },
      };
    },
  ],
];

test('jiraJql builds the open and since queries for an epic and for a jql scope', () => {
  assert.equal(
    jiraJql(cfg, { open: true }),
    'project = ACME AND parent = ACME-120 AND statusCategory != Done ORDER BY key',
  );
  assert.equal(
    jiraJql(cfg, { since: '2026-10-01' }),
    'project = ACME AND parent = ACME-120 AND updated >= "2026-10-01" ORDER BY key',
  );
  const byJql: JiraTrackerConfig = { kind: 'jira', site, projectKey: 'ACME', board: 42, jql: 'labels = checkout' };
  assert.equal(
    jiraJql(byJql, { open: true }),
    'project = ACME AND (labels = checkout) AND statusCategory != Done ORDER BY key',
  );
});

test('board() returns board columns in order, staged from names and status categories, and puts an issue in the column holding its status', async () => {
  const { fetchFn, sent } = jira(boardRoutes());
  const { columns, items } = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).board();
  assert.deepEqual(
    columns.map((c) => [c.name, c.stage]),
    [
      ['To Do', 'not-started'],
      ['In Progress', 'building'],
      ['Code Review', 'in-review'],
      ['Done', 'done'],
    ],
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.key, i.column, i.stage, i.assignedTo, i.parentId, i.sprint, i.url]),
    [
      ['ACME-1', 'ACME-1', 'To Do', 'not-started', 'Pat Doe', 'ACME-120', 'Sprint 14', `https://${site}/browse/ACME-1`],
      ['ACME-2', 'ACME-2', 'Code Review', 'in-review', null, 'ACME-120', 'Sprint 14', `https://${site}/browse/ACME-2`],
    ],
  );
  assert.equal(sent[0].auth, `Basic ${Buffer.from('pat@contoso.test:t0k').toString('base64')}`);
});

test('board() pages through search until isLast', async () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => issue(from + i, '3'));
  const { fetchFn } = jira(boardRoutes([page(1, 100), page(101, 37)]));
  const { items } = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).board();
  assert.equal(items.length, 137);
  assert.equal(items.at(-1)?.key, 'ACME-137');
});

test('sprints() reads dated sprints across pages, and is empty for a kanban board', async () => {
  const { fetchFn } = jira([
    [
      'GET',
      '/rest/agile/1.0/board/42/sprint?state=active,closed&startAt=0',
      () => ({
        status: 200,
        json: {
          isLast: false,
          values: [{ name: 'Sprint 13', startDate: '2026-09-23T14:00:00.000Z', endDate: '2026-10-07T14:00:00.000Z' }],
        },
      }),
    ],
    [
      'GET',
      '/rest/agile/1.0/board/42/sprint?state=active,closed&startAt=1',
      () => ({
        status: 200,
        json: { isLast: true, values: [{ name: 'Sprint 14', startDate: '2026-10-07T14:00:00.000Z' }] },
      }),
    ],
  ]);
  const windows = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).sprints();
  assert.deepEqual(windows, [
    {
      name: 'Sprint 13',
      path: 'Sprint 13',
      start: Date.parse('2026-09-23T14:00:00.000Z'),
      finish: Date.parse('2026-10-07T14:00:00.000Z'),
    },
  ]);
  const kanban = jira([
    [
      'GET',
      '/rest/agile/1.0/board/42/sprint',
      () => ({ status: 400, json: { errorMessages: ['The board does not support sprints'] } }),
    ],
  ]);
  assert.deepEqual(await new JiraAdapter(cfg, new JiraClient(site, creds, kanban.fetchFn)).sprints(), []);
});

test('move() takes the transition that lands in a column of that stage, then comments the note', async () => {
  const { fetchFn, sent } = jira([
    ...boardRoutes(),
    [
      'GET',
      '/rest/api/3/issue/ACME-1/transitions',
      () => ({
        status: 200,
        json: {
          transitions: [
            { id: '11', to: { id: '3' } },
            { id: '21', to: { id: '10002' } },
          ],
        },
      }),
    ],
    ['POST', '/rest/api/3/issue/ACME-1/transitions', () => ({ status: 204, json: {} })],
    ['POST', '/rest/api/3/issue/ACME-1/comment', () => ({ status: 201, json: {} })],
  ]);
  const col = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).move(
    'ACME-1',
    'in-review',
    'PR #41 is up',
  );
  assert.equal(col.name, 'Code Review');
  assert.deepEqual(sent.find((s) => s.method === 'POST' && s.path.endsWith('/transitions'))?.body, {
    transition: { id: '21' },
  });
  assert.deepEqual(sent.find((s) => s.path.endsWith('/comment'))?.body, {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PR #41 is up' }] }],
    },
  });
});

test('move() with no transition into a column of that stage throws TrackerMoveError naming the columns and posts nothing', async () => {
  const { fetchFn, sent } = jira([
    ...boardRoutes(),
    [
      'GET',
      '/rest/api/3/issue/ACME-1/transitions',
      () => ({ status: 200, json: { transitions: [{ id: '11', to: { id: '3' } }] } }),
    ],
  ]);
  await assert.rejects(
    new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).move('ACME-1', 'done'),
    (e: Error) => {
      assert.ok(e instanceof TrackerMoveError);
      assert.match(e.message, /"done"/);
      assert.match(e.message, /Done/);
      return true;
    },
  );
  assert.ok(!sent.some((s) => s.method === 'POST' && !s.path.startsWith('/rest/api/3/search')));
});

test('move() to a stage no column has throws before asking for transitions', async () => {
  const { fetchFn, sent } = jira(boardRoutes());
  await assert.rejects(
    new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).move('ACME-1', 'testing'),
    TrackerMoveError,
  );
  assert.ok(!sent.some((s) => s.path.includes('/transitions')));
});

test('no creds throws TrackerAuthError for the site before any request', async () => {
  const { fetchFn, sent } = jira(boardRoutes());
  await assert.rejects(new JiraAdapter(cfg, new JiraClient(site, () => null, fetchFn)).board(), (e: Error) => {
    assert.ok(e instanceof TrackerAuthError);
    assert.deepEqual(e.ref, { kind: 'jira', site });
    return true;
  });
  assert.equal(sent.length, 0);
});

test('a 401 throws TrackerAuthError', async () => {
  const { fetchFn } = jira([['GET', '/rest/agile/1.0/board/42/configuration', () => ({ status: 401, json: {} })]]);
  await assert.rejects(new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).board(), TrackerAuthError);
});

test('story() turns rendered HTML into text and lists subtasks as children', async () => {
  const { fetchFn } = jira([
    ...boardRoutes(),
    [
      'GET',
      '/rest/api/3/issue/ACME-1?',
      () => ({
        status: 200,
        json: {
          key: 'ACME-1',
          fields: {
            ...issue(1, '3').fields,
            subtasks: [
              {
                key: 'ACME-7',
                fields: { summary: 'wire it', status: { id: '1', name: 'To Do' }, issuetype: { name: 'Sub-task' } },
              },
            ],
            issuelinks: [{ type: { outward: 'blocks' }, outwardIssue: { key: 'ACME-9' } }],
            comment: { comments: [{ created: '2026-10-02T10:00:00.000+0000', author: { displayName: 'Pat Doe' } }] },
          },
          renderedFields: {
            description: '<p>Show every <b>saved</b> card.</p>',
            comment: { comments: [{ body: '<p>Looks &amp; works</p>' }] },
          },
        },
      }),
    ],
  ]);
  const d = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).story('ACME-1');
  assert.equal(d.item.key, 'ACME-1');
  assert.equal(d.description, 'Show every saved card.');
  assert.equal(d.acceptance, null);
  assert.deepEqual(d.comments, [
    { author: 'Pat Doe', at: Date.parse('2026-10-02T10:00:00.000+0000'), text: 'Looks & works' },
  ]);
  assert.deepEqual(
    d.children.map((c) => [c.key, c.title]),
    [['ACME-7', 'wire it']],
  );
  assert.deepEqual(d.links, [{ title: 'blocks ACME-9', url: `https://${site}/browse/ACME-9` }]);
});

test('story() asks for the description field, since Jira renders only the fields it was asked for', async () => {
  const { fetchFn, sent } = jira([
    ...boardRoutes(),
    [
      'GET',
      '/rest/api/3/issue/ACME-1?',
      () => ({ status: 200, json: { key: 'ACME-1', fields: issue(1, '3').fields } }),
    ],
  ]);
  await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).story('ACME-1');
  const get = sent.find((s) => s.path.startsWith('/rest/api/3/issue/ACME-1?'));
  assert.ok(get);
  const fields = new URLSearchParams(get.path.split('?')[1]).get('fields')?.split(',') ?? [];
  assert.ok(fields.includes('description'), `fields were ${fields.join(',')}`);
});
