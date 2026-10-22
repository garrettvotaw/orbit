import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADO_PALETTE } from '../src/shared/ado-palette.ts';
import { AdoAdapter, AdoClient, AdoTokenProvider, type FetchLike } from '../src/main/trackers/ado.ts';
import { openDb } from '../src/main/db.ts';
import { MarkerStore } from '../src/main/trackers/markers.ts';
import {
  TrackerAuthError,
  TrackerMoveError,
  TrackerUnsupportedError,
  htmlToText,
  noColumnError,
  readCapped,
} from '../src/main/trackers/tracker.ts';
import type { AdoTrackerConfig } from '../src/shared/types.ts';

const cfg: AdoTrackerConfig = { kind: 'ado', org: 'contoso', project: 'Storefront', anchorId: 1200 };
const base = 'https://dev.azure.com/contoso/Storefront/_apis/wit';

interface Sent {
  url: string;
  method: string;
  contentType?: string;
  body: unknown;
}

/** What a fake route answers: JSON by default, or raw bytes with a content type. */
type Reply = { status: number; json?: unknown; raw?: Uint8Array | string; type?: string };

/** Routes each request to the first handler whose method and URL prefix match; records everything sent. */
function routes(table: Array<[string, string, (body: unknown) => Reply]>) {
  const sent: Sent[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    sent.push({ url, method: init.method, contentType: init.headers['Content-Type'], body });
    const hit = table.find(([m, prefix]) => m === init.method && url.startsWith(prefix));
    const r: Reply = hit ? hit[2](body) : { status: 404, json: { message: `no route for ${init.method} ${url}` } };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
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
  const col = await ado.move('1301', 'in-review', { note: 'PR #41 is up' });
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

/** The routes of a board whose User Story has its own states, plus the sign-in identity. */
const typedRoutes = (identityCalls: string[]) =>
  routes([
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
            { name: 'Removed', color: 'ffffff', category: 'Removed' },
          ],
        },
      }),
    ],
    [
      'GET',
      'https://dev.azure.com/contoso/_apis/connectionData',
      () => {
        identityCalls.push('me');
        return {
          status: 200,
          json: { authenticatedUser: { properties: { Account: { $value: 'pat@contoso.test' } } } },
        };
      },
    ],
    ['PATCH', `${base}/workitems/1301`, () => ({ status: 200, json: {} })],
  ]);

test('AdoAdapter.move to a named column patches that state, whatever stage it shares', async () => {
  const { fetchFn, sent } = typedRoutes([]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  const col = await ado.move('1301', 'done', { column: 'Removed' });
  assert.equal(col.name, 'Removed');
  assert.deepEqual(sent.find((s) => s.method === 'PATCH')?.body, [
    { op: 'add', path: '/fields/System.State', value: 'Removed' },
  ]);
});

test('AdoAdapter.move with assignToMe sets AssignedTo in the same patch and asks who I am once', async () => {
  const calls: string[] = [];
  const { fetchFn, sent } = typedRoutes(calls);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  await ado.move('1301', 'building', { assignToMe: true });
  await ado.move('1301', 'in-review', { assignToMe: true });
  assert.deepEqual(sent.filter((s) => s.method === 'PATCH')[0].body, [
    { op: 'add', path: '/fields/System.State', value: 'Active' },
    { op: 'add', path: '/fields/System.AssignedTo', value: 'pat@contoso.test' },
  ]);
  assert.deepEqual(calls, ['me']);
});

test('AdoAdapter.move to a column the story cannot reach throws, naming the columns, and sends nothing', async () => {
  const { fetchFn, sent } = typedRoutes([]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  await ado.board();
  const before = sent.length;
  await assert.rejects(ado.move('1301', 'in-review', { column: 'Pull Request' }), (e: Error) => {
    assert.ok(e instanceof TrackerMoveError);
    assert.match(e.message, /"Pull Request"/);
    assert.match(e.message, /Code Review \(in-review\)/);
    return true;
  });
  assert.equal(sent.slice(before).filter((s) => s.method === 'PATCH').length, 0);
});

test('AdoAdapter.story returns repro steps, the parent with its AC, related items with their state, and attachments', async () => {
  const wiUrl = (id: number) => `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`;
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
            'System.WorkItemType': 'Bug',
            'Microsoft.VSTS.TCM.ReproSteps': '<ol><li>Open checkout</li><li>No cards</li></ol>',
          },
          relations: [
            { rel: 'System.LinkTypes.Hierarchy-Reverse', url: wiUrl(1200) },
            { rel: 'System.LinkTypes.Related', url: wiUrl(1305) },
            { rel: 'System.LinkTypes.Dependency-Reverse', url: wiUrl(1306) },
            { rel: 'System.LinkTypes.Duplicate-Reverse', url: wiUrl(1307) },
            {
              rel: 'AttachedFile',
              url: `${base}/attachments/abc?fileName=trace.txt`,
              attributes: { name: 'trace.txt' },
            },
            { rel: 'Hyperlink', url: 'https://example.test/spec', attributes: { comment: 'the spec' } },
          ],
        },
      }),
    ],
    [
      'GET',
      `${base}/workitems/1200`,
      () => ({
        status: 200,
        json: {
          id: 1200,
          fields: {
            'System.Title': 'Checkout',
            'System.State': 'Active',
            'System.WorkItemType': 'Feature',
            'System.Description': '<p>Pay faster.</p>',
            'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>One tap.</p>',
          },
        },
      }),
    ],
    ['GET', `${base}/workItems/1301/comments`, () => ({ status: 200, json: { comments: [] } })],
    [
      'POST',
      `${base}/workitemsbatch`,
      () => ({
        status: 200,
        json: {
          value: [
            story(1305, 'New'),
            story(1306, 'Active'),
            { ...story(1307, 'Closed'), fields: { ...story(1307, 'Closed').fields, 'System.WorkItemType': 'Feature' } },
          ],
        },
      }),
    ],
  ]);
  const d = await new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn)).story('1301');
  assert.equal(d.reproSteps, 'Open checkout\nNo cards');
  assert.deepEqual(d.parent && [d.parent.item.key, d.parent.item.title, d.parent.description, d.parent.acceptance], [
    '1200',
    'Checkout',
    'Pay faster.',
    'One tap.',
  ]);
  assert.deepEqual(
    d.related.map((r) => [r.kind, r.item.key, r.item.column]),
    [
      ['related', '1305', 'New'],
      ['blocked-by', '1306', 'Active'],
      ['duplicate-of', '1307', 'Closed'],
    ],
  );
  assert.deepEqual(d.attachments, [{ name: 'trace.txt', url: `${base}/attachments/abc?fileName=trace.txt` }]);
  assert.deepEqual(d.links, [{ title: 'the spec', url: 'https://example.test/spec' }]);
});

const withAttachment = () =>
  routes([
    [
      'GET',
      `${base}/workitems/1301`,
      () => ({
        status: 200,
        json: {
          id: 1301,
          fields: { 'System.Title': 't', 'System.State': 'Active', 'System.WorkItemType': 'Bug' },
          relations: [
            {
              rel: 'AttachedFile',
              url: `${base}/attachments/abc?fileName=trace.txt`,
              attributes: { name: 'trace.txt' },
            },
            { rel: 'AttachedFile', url: `${base}/attachments/def?fileName=shot.png`, attributes: { name: 'shot.png' } },
          ],
        },
      }),
    ],
    [
      'GET',
      `${base}/attachments/abc`,
      () => ({ status: 200, raw: 'stack trace here', type: 'text/plain; charset=utf-8' }),
    ],
    [
      'GET',
      `${base}/attachments/def`,
      () => ({ status: 200, raw: new Uint8Array([137, 80, 78, 71]), type: 'application/octet-stream' }),
    ],
  ]);

test('AdoAdapter.attachment downloads a named attachment with its type, from the header or the extension', async () => {
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), withAttachment().fetchFn));
  const text = await ado.attachment('1301', 'trace.txt');
  assert.deepEqual(
    [text.name, text.mimeType, new TextDecoder().decode(text.data)],
    ['trace.txt', 'text/plain', 'stack trace here'],
  );
  const png = await ado.attachment('1301', 'shot.png');
  assert.deepEqual([png.mimeType, [...png.data]], ['image/png', [137, 80, 78, 71]]);
});

test('AdoAdapter.attachment with a name the story does not have lists the names it does', async () => {
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), withAttachment().fetchFn));
  await assert.rejects(ado.attachment('1301', 'nope.txt'), (e: Error) => {
    assert.ok(e instanceof TrackerUnsupportedError);
    assert.match(e.message, /trace\.txt, shot\.png/);
    return true;
  });
});

/** Comments on 1301; ADO answers a post or an edit with the text it stored, here as sent unless `stored` says. */
const commentRoutes = (
  comments: Array<{ id: number; text: string; createdBy?: { id?: string; uniqueName?: string } }>,
  stored?: (sent: string) => string,
) => {
  const echo = (b: unknown) => {
    const text = (b as { text: string }).text;
    return { status: 200, json: { id: 12, text: stored ? stored(text) : text } };
  };
  return routes([
    [
      'GET',
      'https://dev.azure.com/contoso/_apis/connectionData',
      () => ({
        status: 200,
        json: { authenticatedUser: { id: 'me-1', properties: { Account: { $value: 'pat@contoso.test' } } } },
      }),
    ],
    ['GET', `${base}/workItems/1301/comments`, () => ({ status: 200, json: { comments } })],
    ['PATCH', `${base}/workItems/1301/comments/`, echo],
    ['POST', `${base}/workItems/1301/comments`, echo],
  ]);
};
const mine = { id: 'me-1', uniqueName: 'pat@contoso.test' };

test('AdoAdapter.comment with a marker edits the comment that carries it', async () => {
  const { fetchFn, sent } = commentRoutes([
    { id: 7, text: '<p>Started</p>' },
    { id: 9, text: '<p>Plan v1</p>\n<!-- orbit:plan -->', createdBy: mine },
  ]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  assert.equal(await ado.comment('1301', 'Plan v2', { marker: 'plan' }), 'updated');
  const edit = sent.find((s) => s.method === 'PATCH');
  assert.match(edit?.url ?? '', /\/workItems\/1301\/comments\/9\?api-version=7\.1-preview\.4$/);
  assert.deepEqual(edit?.body, { text: 'Plan v2\n<!-- orbit:plan -->' });
  assert.equal(sent.filter((s) => s.method === 'POST').length, 0);
});

test('AdoAdapter.comment with a marker posts a marked comment when none carries it, even one that names it', async () => {
  const { fetchFn, sent } = commentRoutes([
    { id: 7, text: '<p>&lt;!-- orbit:plan --&gt; is how Orbit marks its plan</p>' },
    { id: 8, text: '<p>Plan B</p>\n<!-- orbit:plan-b -->' },
  ]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  assert.equal(await ado.comment('1301', 'Plan v1', { marker: 'plan' }), 'posted');
  assert.equal(sent.filter((s) => s.method === 'PATCH').length, 0);
  assert.deepEqual(sent.find((s) => s.method === 'POST')?.body, { text: 'Plan v1\n<!-- orbit:plan -->' });
});

test('AdoAdapter.comment never edits a comment someone else wrote, even one carrying the marker', async () => {
  const { fetchFn, sent } = commentRoutes([
    {
      id: 9,
      text: '<blockquote>Plan v1</blockquote>\n<!-- orbit:plan -->',
      createdBy: { id: 'sam-2', uniqueName: 'sam@contoso.test' },
    },
  ]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  assert.equal(await ado.comment('1301', 'Plan v2', { marker: 'plan' }), 'posted');
  assert.equal(sent.filter((s) => s.method === 'PATCH').length, 0);
});

test('AdoAdapter.comment says when ADO stored the comment without its marker', async () => {
  const { fetchFn } = commentRoutes([], (text) => text.replace(/<!--[\s\S]*?-->/g, ''));
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  assert.equal(await ado.comment('1301', 'Plan v1', { marker: 'plan' }), 'unmarked');
});

test('AdoAdapter.comment without a marker posts without reading the comments', async () => {
  const { fetchFn, sent } = commentRoutes([]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  assert.equal(await ado.comment('1301', 'hi'), 'posted');
  assert.deepEqual(
    sent.map((s) => s.method),
    ['POST'],
  );
});

test('AdoAdapter.link adds the relation to the first story, read from its side, for each kind', async () => {
  const { fetchFn, sent } = routes([['PATCH', `${base}/workitems/1301`, () => ({ status: 200, json: {} })]]);
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  for (const kind of ['duplicate', 'related', 'blocks'] as const) await ado.link('1301', '1302', kind);
  for (const s of sent) {
    assert.match(s.url, /\/workitems\/1301\?api-version=7\.1$/);
    assert.equal(s.contentType, 'application/json-patch+json');
  }
  assert.deepEqual(
    sent.map((s) => s.body),
    ['Duplicate-Reverse', 'Related', 'Dependency-Forward'].map((rel) => [
      {
        op: 'add',
        path: '/relations/-',
        value: { rel: `System.LinkTypes.${rel}`, url: 'https://dev.azure.com/contoso/_apis/wit/workItems/1302' },
      },
    ]),
  );
});

test('AdoAdapter.attach uploads the bytes, then attaches the upload to the work item', async () => {
  const url = `${base}/attachments/abc-123?fileName=crash%20log.txt`;
  const { fetchFn, sent } = routes([
    [
      'POST',
      `${base}/attachments?fileName=crash%20log.txt&api-version=7.1`,
      () => ({ status: 201, json: { id: 'abc-123', url } }),
    ],
    ['PATCH', `${base}/workitems/1301`, () => ({ status: 200, json: {} })],
  ]);
  const data = new TextEncoder().encode('boom');
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn));
  assert.deepEqual(await ado.attach('1301', { name: 'crash log.txt', data }), { name: 'crash log.txt', url });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].contentType, 'application/octet-stream');
  assert.deepEqual(sent[0].body, data);
  assert.match(sent[1].url, /\/workitems\/1301\?api-version=7\.1$/);
  assert.equal(sent[1].contentType, 'application/json-patch+json');
  assert.deepEqual(sent[1].body, [{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url } }]);
});

test('AdoAdapter.story skips a related item ADO no longer returns, and reads a deleted parent as none', async () => {
  const wiUrl = (id: number) => `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`;
  const { fetchFn, sent } = routes([
    [
      'GET',
      `${base}/workitems/1301`,
      () => ({
        status: 200,
        json: {
          id: 1301,
          fields: { 'System.Title': 'Saved cards', 'System.State': 'Active', 'System.WorkItemType': 'Bug' },
          relations: [
            { rel: 'System.LinkTypes.Hierarchy-Reverse', url: wiUrl(1200) },
            { rel: 'System.LinkTypes.Related', url: wiUrl(1305) },
            { rel: 'System.LinkTypes.Related', url: wiUrl(1399) },
          ],
        },
      }),
    ],
    [
      'GET',
      `${base}/workitems/1200`,
      () => ({
        status: 404,
        json: { message: 'TF401232: Work item 1200 does not exist, or you do not have permissions to read it.' },
      }),
    ],
    ['GET', `${base}/workItems/1301/comments`, () => ({ status: 200, json: { comments: [] } })],
    ['POST', `${base}/workitemsbatch`, () => ({ status: 200, json: { value: [story(1305, 'New'), null] } })],
  ]);
  const d = await new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn)).story('1301');
  assert.equal(d.parent, null);
  assert.deepEqual(
    d.related.map((r) => r.item.key),
    ['1305'],
  );
  const batch = sent.find((s) => s.url.includes('/workitemsbatch'));
  assert.equal((batch?.body as { errorPolicy?: string }).errorPolicy, 'Omit');
});

test('readCapped stops downloading past the cap and keeps the size the server gave', async () => {
  const MB = 1024 * 1024;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (pulls > 8) c.close();
      else c.enqueue(new Uint8Array(MB));
    },
  });
  const res = {
    body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: (k: string) => (k === 'content-length' ? String(8 * MB) : null) },
  };
  const got = await readCapped(res, 5 * MB);
  assert.equal(got.data.length, 5 * MB);
  assert.equal(got.size, 8 * MB);
  assert.ok(pulls < 8, `stopped after ${pulls} chunks`);
});

test('readCapped reads a short body whole, and says the size is unknown when a long one has no length', async () => {
  const stream = (chunks: number[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of chunks) c.enqueue(new Uint8Array(n));
        c.close();
      },
    });
  const none = { get: () => null };
  const short = await readCapped(
    { body: stream([3, 4]), arrayBuffer: async () => new ArrayBuffer(0), headers: none },
    10,
  );
  assert.deepEqual([short.data.length, short.size], [7, 7]);
  const long = await readCapped(
    { body: stream([6, 6]), arrayBuffer: async () => new ArrayBuffer(0), headers: none },
    10,
  );
  assert.deepEqual([long.data.length, long.size], [10, null]);
  const buffered = await readCapped({ arrayBuffer: async () => new Uint8Array(12).buffer }, 10);
  assert.deepEqual([buffered.data.length, buffered.size], [10, 12]);
});

/** ADO as it really answers: a marked comment comes back with its hidden tag stripped. */
const strippingRoutes = (comment12: 'live' | 'deleted') => {
  const stripped = (b: unknown) => ({
    status: 200,
    json: { id: comment12 === 'live' ? 12 : 13, text: (b as { text: string }).text.replace(/<!--[\s\S]*?-->/g, '') },
  });
  return routes([
    [
      'GET',
      'https://dev.azure.com/contoso/_apis/connectionData',
      () => ({
        status: 200,
        json: { authenticatedUser: { id: 'me-1', properties: { Account: { $value: 'pat@contoso.test' } } } },
      }),
    ],
    [
      'GET',
      `${base}/workItems/1301/comments/12`,
      () =>
        comment12 === 'live'
          ? { status: 200, json: { id: 12 } }
          : { status: 404, json: { message: 'VS403662: Comment 12 does not exist.' } },
    ],
    ['GET', `${base}/workItems/1301/comments`, () => ({ status: 200, json: { comments: [] } })],
    ['PATCH', `${base}/workItems/1301/comments/12`, stripped],
    ['POST', `${base}/workItems/1301/comments`, stripped],
  ]);
};

test('AdoAdapter.comment remembers the marked comment it posted, and edits that one next time though ADO dropped the tag', async () => {
  const markers = new MarkerStore(openDb(':memory:')).for({ kind: 'ado', site: 'contoso' });
  const { fetchFn, sent } = strippingRoutes('live');
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn), markers);
  assert.equal(await ado.comment('1301', 'Plan v1', { marker: 'plan' }), 'posted');
  assert.equal(markers.get('1301', 'plan'), '12');
  assert.equal(await ado.comment('1301', 'Plan v2', { marker: 'plan' }), 'updated');
  assert.equal(sent.filter((s) => s.method === 'POST').length, 1, 'posted once');
  const edit = sent.find((s) => s.method === 'PATCH');
  assert.match(edit?.url ?? '', /\/workItems\/1301\/comments\/12\?/);
  assert.deepEqual(edit?.body, { text: 'Plan v2\n<!-- orbit:plan -->' });
});

test('AdoAdapter.comment posts afresh when the remembered comment was deleted, and remembers the new one', async () => {
  const markers = new MarkerStore(openDb(':memory:')).for({ kind: 'ado', site: 'contoso' });
  markers.set('1301', 'plan', '12');
  const { fetchFn, sent } = strippingRoutes('deleted');
  const ado = new AdoAdapter(cfg, new AdoClient(tokens(), fetchFn), markers);
  assert.equal(await ado.comment('1301', 'Plan v3', { marker: 'plan' }), 'posted');
  assert.equal(sent.filter((s) => s.method === 'PATCH').length, 0, 'nothing edited');
  assert.equal(markers.get('1301', 'plan'), '13');
});
