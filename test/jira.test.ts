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
  token?: string;
  contentType?: string;
  body: unknown;
}
type Handler = (
  body: unknown,
  path: string,
) => { status: number; json?: unknown; raw?: Uint8Array | string; type?: string };

/** Routes on method plus the start of the path (query string included); records every request. */
function jira(table: Array<[string, string, Handler]>) {
  const sent: Sent[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const p = url.replace(`https://${site}`, '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    sent.push({
      method: init.method,
      path: p,
      auth: init.headers.Authorization,
      token: init.headers['X-Atlassian-Token'],
      contentType: init.headers['Content-Type'],
      body,
    });
    const hit = table.find(([m, prefix]) => m === init.method && p.startsWith(prefix));
    const r = hit ? hit[2](body, p) : { status: 404, json: { errorMessages: [`no route ${init.method} ${p}`] } };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      // Like real fetch: a response with no body has no JSON.
      json: async () => {
        if (r.json === undefined) throw new SyntaxError('Unexpected end of JSON input');
        return r.json;
      },
      text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)),
      arrayBuffer: async () => {
        const bytes =
          typeof r.raw === 'string'
            ? new TextEncoder().encode(r.raw)
            : (r.raw ?? new TextEncoder().encode(JSON.stringify(r.json)));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (r.type ?? 'application/json') : null) },
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
  const col = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).move('ACME-1', 'in-review', {
    note: 'PR #41 is up',
  });
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
      '/rest/api/3/issue/ACME-120?',
      () => ({ status: 200, json: { key: 'ACME-120', fields: { summary: 'Epic' } } }),
    ],
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
  assert.deepEqual(d.links, []);
  assert.deepEqual(
    d.related.map((r) => [r.kind, r.item.key]),
    [['blocks', 'ACME-9']],
  );
});

test('story() asks for the description field, since Jira renders only the fields it was asked for', async () => {
  const { fetchFn, sent } = jira([
    ...boardRoutes(),
    [
      'GET',
      '/rest/api/3/issue/ACME-120?',
      () => ({ status: 200, json: { key: 'ACME-120', fields: { summary: 'Epic' } } }),
    ],
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

test('move() to a named column takes the transition into that column, whatever the stage says', async () => {
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
  ]);
  const col = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).move('ACME-1', 'building', {
    column: 'Code Review',
  });
  assert.equal(col.name, 'Code Review');
  assert.deepEqual(sent.find((s) => s.method === 'POST' && s.path.endsWith('/transitions'))?.body, {
    transition: { id: '21' },
  });
});

test('move() with assignToMe puts the accountId from /myself on the issue, asking once', async () => {
  let asked = 0;
  const { fetchFn, sent } = jira([
    ...boardRoutes(),
    [
      'GET',
      '/rest/api/3/issue/ACME-1/transitions',
      () => ({ status: 200, json: { transitions: [{ id: '11', to: { id: '3' } }] } }),
    ],
    ['POST', '/rest/api/3/issue/ACME-1/transitions', () => ({ status: 204, json: {} })],
    [
      'GET',
      '/rest/api/3/myself',
      () => {
        asked++;
        return { status: 200, json: { accountId: 'acct-1' } };
      },
    ],
    ['PUT', '/rest/api/3/issue/ACME-1/assignee', () => ({ status: 204, json: {} })],
  ]);
  const adapter = new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn));
  await adapter.move('ACME-1', 'building', { assignToMe: true });
  await adapter.move('ACME-1', 'building', { assignToMe: true });
  assert.deepEqual(sent.find((s) => s.method === 'PUT')?.body, { accountId: 'acct-1' });
  assert.equal(asked, 1);
});

test('move() to a column the board does not have throws, naming the columns', async () => {
  const { fetchFn, sent } = jira(boardRoutes());
  await assert.rejects(
    new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).move('ACME-1', 'done', { column: 'Shipped' }),
    (e: Error) =>
      e instanceof TrackerMoveError && /"Shipped"/.test(e.message) && /To Do \(not-started\)/.test(e.message),
  );
  assert.ok(!sent.some((s) => s.path.includes('/transitions')));
});

test('story() returns the parent with its description, related issues with their state, and attachments', async () => {
  const { fetchFn, sent } = jira([
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
            parent: { key: 'ACME-120' },
            issuelinks: [
              { type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }, outwardIssue: issue(9, '1') },
              {
                type: { name: 'Duplicate', outward: 'duplicates', inward: 'is duplicated by' },
                inwardIssue: issue(8, '10003'),
              },
              { type: { name: 'Relates', outward: 'relates to', inward: 'relates to' }, outwardIssue: issue(7, '3') },
            ],
            attachment: [{ filename: 'trace.txt', content: `https://${site}/rest/api/3/attachment/content/55` }],
          },
          renderedFields: {},
        },
      }),
    ],
    [
      'GET',
      '/rest/api/3/issue/ACME-120?',
      () => ({
        status: 200,
        json: {
          key: 'ACME-120',
          fields: { summary: 'Checkout', status: { id: '3' }, issuetype: { name: 'Epic' } },
          renderedFields: { description: '<p>Pay faster.</p>' },
        },
      }),
    ],
  ]);
  const d = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).story('ACME-1');
  const fields = new URLSearchParams(
    sent.find((s) => s.path.startsWith('/rest/api/3/issue/ACME-1?'))!.path.split('?')[1],
  )
    .get('fields')!
    .split(',');
  for (const f of ['parent', 'issuelinks', 'attachment']) assert.ok(fields.includes(f), f);
  assert.equal(d.reproSteps, null);
  assert.deepEqual(d.parent && [d.parent.item.key, d.parent.description, d.parent.acceptance], [
    'ACME-120',
    'Pay faster.',
    null,
  ]);
  assert.deepEqual(
    d.related.map((r) => [r.kind, r.item.key, r.item.column]),
    [
      ['blocks', 'ACME-9', 'To Do'],
      ['duplicate', 'ACME-8', 'Done'],
      ['related', 'ACME-7', 'In Progress'],
    ],
  );
  assert.deepEqual(d.attachments, [{ name: 'trace.txt', url: `https://${site}/rest/api/3/attachment/content/55` }]);
});

test('attachment() downloads the named file from its content URL', async () => {
  const { fetchFn, sent } = jira([
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
            parent: null,
            attachment: [{ filename: 'trace.txt', content: `https://${site}/rest/api/3/attachment/content/55` }],
          },
        },
      }),
    ],
    ['GET', '/rest/api/3/attachment/content/55', () => ({ status: 200, raw: 'boom', type: 'text/plain' })],
  ]);
  const file = await new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn)).attachment('ACME-1', 'trace.txt');
  assert.deepEqual([file.mimeType, new TextDecoder().decode(file.data), file.size], ['text/plain', 'boom', 4]);
  assert.ok(sent.at(-1)?.auth?.startsWith('Basic '), 'the download is signed in');
});

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const commentTable = (comments: unknown[]): Array<[string, string, Handler]> => [
  [
    'GET',
    '/rest/api/3/issue/ACME-1/comment?expand=properties',
    () => ({ status: 200, json: { comments, total: comments.length } }),
  ],
  ['PUT', '/rest/api/3/issue/ACME-1/comment/', () => ({ status: 200, json: {} })],
  ['POST', '/rest/api/3/issue/ACME-1/comment', () => ({ status: 201, json: {} })],
];

test('comment() with a marker edits the comment whose orbit-marker property matches', async () => {
  const { fetchFn, sent } = jira(
    commentTable([
      { id: '10', body: adf('Started'), properties: [] },
      { id: '11', body: adf('Plan v1'), properties: [{ key: 'orbit-marker', value: 'plan' }] },
    ]),
  );
  const ad = new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn));
  assert.equal(await ad.comment('ACME-1', 'Plan v2', { marker: 'plan' }), 'updated');
  const put = sent.find((s) => s.method === 'PUT');
  assert.equal(put?.path, '/rest/api/3/issue/ACME-1/comment/11');
  assert.deepEqual(put?.body, { body: adf('Plan v2') });
  assert.equal(sent.filter((s) => s.method === 'POST').length, 0);
});

test('comment() with a marker posts one carrying the property when none has it, even a comment that names it', async () => {
  const { fetchFn, sent } = jira(
    commentTable([
      { id: '10', body: adf('orbit-marker: plan'), properties: [] },
      { id: '12', body: adf('Plan B'), properties: [{ key: 'orbit-marker', value: 'plan-b' }] },
    ]),
  );
  const ad = new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn));
  assert.equal(await ad.comment('ACME-1', 'Plan v1', { marker: 'plan' }), 'posted');
  assert.equal(sent.filter((s) => s.method === 'PUT').length, 0);
  assert.deepEqual(sent.find((s) => s.method === 'POST')?.body, {
    body: adf('Plan v1'),
    properties: [{ key: 'orbit-marker', value: 'plan' }],
  });
});

test('link() posts an issueLink with the first issue on the side that reads "duplicates" or "blocks"', async () => {
  // Jira answers 201 with no body. In the POST, inwardIssue is the issue linked from: it reads with the
  // type's outward wording, so { inwardIssue: A, outwardIssue: B } on Blocks is "A blocks B".
  const { fetchFn, sent } = jira([['POST', '/rest/api/3/issueLink', () => ({ status: 201 })]]);
  const ad = new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn));
  for (const kind of ['duplicate', 'related', 'blocks'] as const) await ad.link('ACME-1', 'ACME-2', kind);
  assert.deepEqual(
    sent.map((s) => s.body),
    ['Duplicate', 'Relates', 'Blocks'].map((name) => ({
      type: { name },
      inwardIssue: { key: 'ACME-1' },
      outwardIssue: { key: 'ACME-2' },
    })),
  );
});

test('attach() posts the file as multipart field "file" with the no-check header', async () => {
  const content = `https://${site}/rest/api/3/attachment/content/77`;
  const { fetchFn, sent } = jira([
    [
      'POST',
      '/rest/api/3/issue/ACME-1/attachments',
      () => ({ status: 200, json: [{ id: '77', filename: 'trace.txt', content }] }),
    ],
  ]);
  const ad = new JiraAdapter(cfg, new JiraClient(site, creds, fetchFn));
  const data = new TextEncoder().encode('boom');
  assert.deepEqual(await ad.attach('ACME-1', { name: 'trace.txt', data }), { name: 'trace.txt', url: content });
  const form = sent[0].body;
  assert.ok(form instanceof FormData);
  const file = form.get('file') as File;
  assert.equal(file.name, 'trace.txt');
  assert.equal(await file.text(), 'boom');
  assert.equal(sent[0].token, 'no-check');
  assert.equal(sent[0].contentType, undefined, 'fetch sets the multipart boundary itself');
});
