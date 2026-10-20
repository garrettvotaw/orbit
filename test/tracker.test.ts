import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADO_PALETTE } from '../src/shared/ado-palette.ts';
import { AdoAdapter, AdoClient, AdoTokenProvider, type FetchLike } from '../src/main/trackers/ado.ts';
import { TrackerAuthError, TrackerMoveError, htmlToText, noColumnError } from '../src/main/trackers/tracker.ts';
import type { AdoTrackerConfig } from '../src/shared/types.ts';

const cfg: AdoTrackerConfig = { kind: 'ado', org: 'contoso', project: 'Storefront', anchorId: 1200 };
const base = 'https://dev.azure.com/contoso/Storefront/_apis/wit';

interface Sent {
  url: string;
  method: string;
  contentType?: string;
  body: unknown;
}

/** Routes each request to the first handler whose method and URL prefix match; records everything sent. */
function routes(table: Array<[string, string, (body: unknown) => { status: number; json: unknown }]>) {
  const sent: Sent[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    sent.push({ url, method: init.method, contentType: init.headers['Content-Type'], body });
    const hit = table.find(([m, prefix]) => m === init.method && url.startsWith(prefix));
    const r = hit ? hit[2](body) : { status: 404, json: { message: `no route for ${init.method} ${url}` } };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    };
  };
  return { fetchFn, sent };
}

const tokens = () =>
  new AdoTokenProvider(async () => JSON.stringify({ accessToken: 't', expires_on: Date.now() / 1000 + 3600 }));

const story = (id: number, state: string, type = 'User Story') => ({
  id,
  fields: { 'System.Title': `story ${id}`, 'System.State': state, 'System.WorkItemType': type },
});

const boardRoutes = () =>
  routes([
    [
      'POST',
      `${base}/wiql`,
      () => ({ status: 200, json: { workItemRelations: [{ target: { id: 1301 } }, { target: { id: 1302 } }] } }),
    ],
    [
      'POST',
      `${base}/workitemsbatch`,
      () => ({ status: 200, json: { value: [story(1301, 'Ready'), story(1302, 'Resolved', 'Bug')] } }),
    ],
    [
      'GET',
      `${base}/workitemtypes/User%20Story/states`,
      () => ({
        status: 200,
        json: {
          value: [
            { name: 'Ready', color: '00ff00', category: 'Proposed' },
            { name: 'Pull Request', color: 'a78bfa', category: 'InProgress' },
          ],
        },
      }),
    ],
    [
      'GET',
      `${base}/workitemtypes/Bug/states`,
      () => ({ status: 200, json: { value: [{ name: 'Resolved', color: 'ff9d00', category: 'Resolved' }] } }),
    ],
    ['PATCH', `${base}/workitems/1301`, () => ({ status: 200, json: {} })],
    ['POST', `${base}/workItems/1301/comments`, () => ({ status: 200, json: {} })],
  ]);

test('AdoAdapter.board returns the palette columns plus unlisted states, and items staged from the API categories', async () => {
  const { fetchFn } = boardRoutes();
  const { columns, items } = await new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn)).board();
  assert.deepEqual(
    columns.slice(0, ADO_PALETTE.length).map((c) => c.name),
    ADO_PALETTE.map((p) => p.name),
  );
  assert.deepEqual(columns.at(-1), { name: 'Resolved', stage: 'testing', color: '#ff9d00' });
  assert.deepEqual(
    items.map((i) => [i.id, i.key, i.column, i.stage]),
    [
      ['1301', '1301', 'Ready', 'not-started'],
      ['1302', '1302', 'Resolved', 'testing'],
    ],
  );
});

test('AdoAdapter.move patches System.State to the first column with that stage, then comments the note', async () => {
  const { fetchFn, sent } = boardRoutes();
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  const col = await ado.move('1301', 'in-review', 'PR #41 is up');
  assert.equal(col.name, 'Pull Request');
  const patch = sent.find((s) => s.method === 'PATCH');
  assert.ok(patch);
  assert.match(patch.url, /\/workitems\/1301\?api-version=7\.1$/);
  assert.equal(patch.contentType, 'application/json-patch+json');
  assert.deepEqual(patch.body, [{ op: 'add', path: '/fields/System.State', value: 'Pull Request' }]);
  const comment = sent.find((s) => s.method === 'POST' && s.url.includes('/comments'));
  assert.deepEqual(comment?.body, { text: 'PR #41 is up' });
});

test('AdoAdapter.move to a stage with no column throws noColumnError and sends nothing', async () => {
  const { fetchFn, sent } = boardRoutes();
  const ado = new AdoAdapter(
    { ...cfg, stages: Object.fromEntries(ADO_PALETTE.map((p) => [p.name, 'building'])) },
    new AdoClient(tokens(), fetchFn),
  );
  await ado.board();
  const before = sent.length;
  await assert.rejects(
    ado.move('1301', 'blocked'),
    (e: Error) => e instanceof TrackerMoveError && /"blocked"/.test(e.message),
  );
  assert.equal(sent.length, before);
});

test('AdoAdapter.move turns ADO refusing the state into a TrackerMoveError', async () => {
  const { fetchFn } = routes([
    ['POST', `${base}/wiql`, () => ({ status: 200, json: { workItemRelations: [] } })],
    ['GET', `${base}/workitems/1301`, () => ({ status: 200, json: story(1301, 'Active') })],
    [
      'GET',
      `${base}/workitemtypes/User%20Story/states`,
      () => ({ status: 200, json: { value: [{ name: 'Pull Request', color: 'a78bfa', category: 'InProgress' }] } }),
    ],
    [
      'PATCH',
      `${base}/workitems/1301`,
      () => ({
        status: 400,
        json: {
          message: 'The field State contains the value Pull Request that is not in the list of supported values',
        },
      }),
    ],
  ]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  await assert.rejects(
    ado.move('1301', 'in-review'),
    (e: Error) => e instanceof TrackerMoveError && /not in the list/.test(e.message),
  );
});

test('AdoAdapter.story turns HTML description, acceptance criteria, and comments into text', async () => {
  const { fetchFn } = routes([
    [
      'GET',
      `${base}/workitems/1301`,
      () => ({
        status: 200,
        json: {
          id: 1301,
          fields: {
            'System.Title': 'Saved cards',
            'System.State': 'Active',
            'System.WorkItemType': 'User Story',
            'System.Description': '<p>Show every <b>saved</b> card.</p>',
            'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>One</li><li>Two &amp; three</li></ul>',
          },
          relations: [{ rel: 'System.LinkTypes.Hierarchy-Forward', url: `${base}/workItems/1310` }],
        },
      }),
    ],
    [
      'GET',
      `${base}/workItems/1301/comments`,
      () => ({
        status: 200,
        json: {
          comments: [
            {
              text: '<div>Looks good</div>',
              createdBy: { displayName: 'Pat Doe' },
              createdDate: '2026-10-01T12:00:00Z',
            },
          ],
        },
      }),
    ],
    ['POST', `${base}/workitemsbatch`, () => ({ status: 200, json: { value: [story(1310, 'New', 'Task')] } })],
  ]);
  const detail = await new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn)).story('1301');
  assert.equal(detail.item.title, 'Saved cards');
  assert.equal(detail.description, 'Show every saved card.');
  assert.equal(detail.acceptance, 'One\nTwo & three');
  assert.deepEqual(detail.comments, [
    { author: 'Pat Doe', at: Date.parse('2026-10-01T12:00:00Z'), text: 'Looks good' },
  ]);
  assert.deepEqual(
    detail.children.map((c) => c.id),
    ['1310'],
  );
});

test('a 401 throws TrackerAuthError with the org as its site', async () => {
  const { fetchFn } = routes([['POST', `${base}/wiql`, () => ({ status: 401, json: {} })]]);
  await assert.rejects(new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn)).board(), (e: Error) => {
    assert.ok(e instanceof TrackerAuthError);
    assert.deepEqual(e.ref, { kind: 'ado', site: 'contoso' });
    return true;
  });
});

test('htmlToText drops tags, breaks lines on br, p, div, and li, and decodes entities', () => {
  assert.equal(htmlToText('<p>a<br>b</p><p>c &amp; d</p>'), 'a\nb\nc & d');
  assert.equal(htmlToText('<ul><li>x &lt;y&gt;</li><li>&quot;z&#39;&nbsp;</li></ul>'), 'x <y>\n"z\'');
  assert.equal(htmlToText(''), '');
});

test('noColumnError names the stage and every column with its stage', () => {
  const e = noColumnError('testing', [
    { name: 'To Do', stage: 'not-started', color: '#1' },
    { name: 'Doing', stage: 'building', color: '#2' },
  ]);
  assert.equal(e.message, 'No column on this board is "testing". Its columns: To Do (not-started), Doing (building)');
});

test('AdoAdapter.move only targets states the item type really has', async () => {
  const { fetchFn, sent } = routes([
    ['POST', `${base}/wiql`, () => ({ status: 200, json: { workItemRelations: [{ target: { id: 1301 } }] } })],
    ['POST', `${base}/workitemsbatch`, () => ({ status: 200, json: { value: [story(1301, 'Active')] } })],
    [
      'GET',
      `${base}/workitemtypes/User%20Story/states`,
      () => ({
        status: 200,
        json: {
          value: [
            { name: 'New', color: 'b2b2b2', category: 'Proposed' },
            { name: 'Active', color: '007acc', category: 'InProgress' },
            { name: 'Code Review', color: 'aa00ff', category: 'InProgress' },
            { name: 'Closed', color: '339933', category: 'Completed' },
          ],
        },
      }),
    ],
    ['PATCH', `${base}/workitems/1301`, () => ({ status: 200, json: {} })],
  ]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  const col = await ado.move('1301', 'in-review');
  assert.equal(col.name, 'Code Review', 'not the palette Pull Request this process has no state for');
  assert.deepEqual(sent.find((s) => s.method === 'PATCH')?.body, [
    { op: 'add', path: '/fields/System.State', value: 'Code Review' },
  ]);
  const patches = sent.filter((s) => s.method === 'PATCH').length;
  await assert.rejects(ado.move('1301', 'testing'), (e: Error) => {
    assert.ok(e instanceof TrackerMoveError);
    assert.match(
      e.message,
      /Its columns: New \(not-started\), Active \(building\), Code Review \(in-review\), Closed \(done\)/,
    );
    return true;
  });
  assert.equal(sent.filter((s) => s.method === 'PATCH').length, patches, 'no PATCH for an unreachable stage');
});
