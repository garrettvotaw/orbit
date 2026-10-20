import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackerAuthError } from '../src/main/trackers/tracker.ts';
import {
  AdoClient,
  AdoTokenProvider,
  idsFromWiql,
  mapBatch,
  parseAzToken,
  parseSprints,
  shippedWiqlFor,
  wiqlFor,
  type FetchLike,
} from '../src/main/trackers/ado.ts';
import type { AdoTrackerConfig, ProjectConfig } from '../src/shared/types.ts';

const cfg: ProjectConfig = {
  id: 'shop',
  name: 'Shop',
  agent: 'shop-pm',
  cwd: 'c',
  ado: { org: 'contoso', project: 'Storefront', anchorId: 1200 },
  kickoff: 'go',
};
const adoCfg: AdoTrackerConfig = { kind: 'ado', org: 'contoso', project: 'Storefront', anchorId: 1200 };

test('parseAzToken reads expires_on epoch seconds', () => {
  const t = parseAzToken(
    JSON.stringify({ accessToken: 'abc', expiresOn: '2026-10-06 15:03:00.000000', expires_on: 1791316980 }),
  );
  assert.equal(t.accessToken, 'abc');
  assert.equal(t.expiresAt, 1791316980 * 1000);
  assert.throws(() => parseAzToken('{}'), /no accessToken/);
});

test('AdoTokenProvider caches until five minutes before expiry and dedupes inflight calls', async () => {
  let calls = 0;
  let now = 1_000_000;
  const exp = (now + 10 * 60_000) / 1000;
  const p = new AdoTokenProvider(
    async () => {
      calls++;
      return JSON.stringify({ accessToken: `t${calls}`, expires_on: exp });
    },
    () => now,
  );
  const [a, b] = await Promise.all([p.get(), p.get()]);
  assert.equal(a, 't1');
  assert.equal(b, 't1');
  assert.equal(calls, 1);
  now += 4 * 60_000;
  assert.equal(await p.get(), 't1', 'still fresh with 6 minutes left');
  now += 2 * 60_000;
  assert.equal(await p.get(), 't2', 'refreshed inside the five-minute skew');
});

test('wiqlFor targets the anchor, hierarchy-forward, recursive, excluding closed and removed', () => {
  const q = wiqlFor(1200);
  assert.match(q, /\[Source\]\.\[System\.Id\] = 1200/);
  assert.match(q, /Hierarchy-Forward/);
  assert.match(q, /NOT IN \('Closed','Removed'\)/);
  assert.match(q, /MODE \(Recursive\)/);
});

test('shippedWiqlFor keeps closed stories changed since the date, and drops only removed ones', () => {
  const q = shippedWiqlFor(1100, '2026-09-09');
  assert.match(q, /\[Source\]\.\[System\.Id\] = 1100/);
  assert.match(q, /\[Target\]\.\[System\.State\] <> 'Removed'/);
  assert.match(q, /\[Target\]\.\[System\.ChangedDate\] >= '2026-09-09'/);
  assert.doesNotMatch(q, /'Closed'/);
  assert.match(q, /MODE \(Recursive\)/);
});

test('parseSprints keeps the dated top-level iterations, from local midnight to the midnight after the last day', () => {
  const windows = parseSprints(
    {
      name: 'Storefront',
      children: [
        {
          name: 'Sprint 14 (9.30 - 10.20)',
          attributes: { startDate: '2026-09-30T00:00:00Z', finishDate: '2026-10-20T00:00:00Z' },
        },
        { name: 'QA Backlog', children: [{ name: 'QA 2026' }] },
        { name: 'Half planned', attributes: { startDate: '2026-11-01T00:00:00Z' } },
      ],
    },
    'Storefront',
  );
  assert.deepEqual(windows, [
    {
      name: 'Sprint 14 (9.30 - 10.20)',
      path: 'Storefront\\Sprint 14 (9.30 - 10.20)',
      start: new Date(2026, 8, 30).getTime(),
      finish: new Date(2026, 9, 21).getTime(),
    },
  ]);
  assert.deepEqual(parseSprints({}, 'Storefront'), []);
});

test('idsFromWiql drops the anchor and duplicates', () => {
  const ids = idsFromWiql(
    {
      workItemRelations: [
        { target: { id: 1200 } },
        { target: { id: 1210 } },
        { target: { id: 1303 } },
        { target: { id: 1210 } },
      ],
    },
    1200,
  );
  assert.deepEqual(ids, [1210, 1303]);
});

const batch = [
  {
    id: 1301,
    fields: {
      'System.Title': 'Checkout lists every saved card',
      'System.State': 'Owner Review',
      'System.WorkItemType': 'User Story',
      'System.AssignedTo': { displayName: 'Pat Doe' },
      'System.Parent': 1211,
      'System.IterationPath': 'Storefront\\Sprint 41',
    },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/contoso/x/_apis/wit/workItems/1211' },
      { rel: 'ArtifactLink', url: 'vstfs:///GitHub/Commit/0f0f0f0f-0000-4000-8000-000000000001%2f683be97b' },
      { rel: 'ArtifactLink', url: 'vstfs:///GitHub/PullRequest/0f0f0f0f-0000-4000-8000-000000000001%2f7104' },
    ],
  },
  {
    id: 1210,
    fields: { 'System.Title': 'Feature container', 'System.State': 'Active', 'System.WorkItemType': 'Feature' },
  },
  {
    id: 1302,
    fields: { 'System.Title': 'Blank receipt images', 'System.State': 'Pull Request', 'System.WorkItemType': 'Bug' },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/contoso/x/_apis/wit/workItems/1211' },
    ],
  },
];

test('mapBatch drops containers, extracts PR numbers, parent, assignee, and url', () => {
  const items = mapBatch(batch, 'contoso', 'Storefront');
  assert.deepEqual(
    items.map((i) => i.id),
    [1301, 1302],
  );
  const story = items[0];
  assert.equal(story.state, 'Owner Review');
  assert.equal(story.assignedTo, 'Pat Doe');
  assert.equal(story.parentId, 1211);
  assert.deepEqual(story.prNumbers, [7104]);
  assert.equal(story.url, 'https://dev.azure.com/contoso/Storefront/_workitems/edit/1301');
  assert.equal(items[1].parentId, 1211, 'parent from the reverse link when the field is absent');
  assert.equal(items[1].assignedTo, null);
  assert.equal(story.iterationPath, 'Storefront\\Sprint 41', 'the sprint it is planned in');
  assert.equal(items[1].iterationPath, null);
});

function fakeFetch(handler: (url: string, body: unknown) => { status: number; json: unknown }): FetchLike {
  return async (url, init) => {
    const r = handler(url, init.body === undefined ? undefined : JSON.parse(init.body));
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    };
  };
}

test('AdoClient runs wiql then batch with expand=relations and no fields', async () => {
  const seen: unknown[] = [];
  const client = new AdoClient(
    new AdoTokenProvider(async () => JSON.stringify({ accessToken: 't', expires_on: Date.now() / 1000 + 3600 })),
    fakeFetch((url, body) => {
      seen.push(body);
      if (url.includes('/wiql'))
        return { status: 200, json: { workItemRelations: [{ target: { id: 1200 } }, { target: { id: 1301 } }] } };
      return { status: 200, json: { value: [batch[0]] } };
    }),
  );
  const items = await client.items(adoCfg);
  assert.equal(items.length, 1);
  const batchBody = seen[1] as Record<string, unknown>;
  assert.deepEqual(batchBody.ids, [1301]);
  assert.equal(batchBody.$expand, 'relations');
  assert.equal('fields' in batchBody, false);
});

test('AdoClient reads the sprints with a GET and the shipped stories with their own WIQL', async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const client = new AdoClient(
    new AdoTokenProvider(async () => JSON.stringify({ accessToken: 't', expires_on: Date.now() / 1000 + 3600 })),
    fakeFetch((url, body) => {
      seen.push({ url, body });
      if (url.includes('/classificationnodes/'))
        return {
          status: 200,
          json: {
            children: [
              { name: 'S1', attributes: { startDate: '2026-09-30T00:00:00Z', finishDate: '2026-10-20T00:00:00Z' } },
            ],
          },
        };
      if (url.includes('/wiql'))
        return { status: 200, json: { workItemRelations: [{ target: { id: 1100 } }, { target: { id: 1304 } }] } };
      return { status: 200, json: { value: [{ ...batch[0], id: 1304 }] } };
    }),
  );
  const windows = await client.fetchSprints('contoso', 'Storefront');
  assert.equal(windows[0].path, 'Storefront\\S1');
  assert.match(seen[0].url, /\/Storefront\/_apis\/wit\/classificationnodes\/Iterations\?\$depth=1&api-version=7\.1$/);
  assert.equal(seen[0].body, undefined, 'a GET has no body');
  const shipped = await client.shippedItems({ ...adoCfg, anchorId: 1100 }, '2026-09-09');
  assert.deepEqual(
    shipped.map((i) => i.id),
    [1304],
  );
  assert.match((seen[1].body as { query: string }).query, /<> 'Removed'/);
});

test('AdoClient turns 401 into TrackerAuthError and invalidates the token', async () => {
  let tokenCalls = 0;
  const tokens = new AdoTokenProvider(async () => {
    tokenCalls++;
    return JSON.stringify({ accessToken: 't', expires_on: Date.now() / 1000 + 3600 });
  });
  const client = new AdoClient(
    tokens,
    fakeFetch(() => ({ status: 401, json: {} })),
  );
  await assert.rejects(client.items(adoCfg), TrackerAuthError);
  await assert.rejects(client.items(adoCfg), TrackerAuthError);
  assert.equal(tokenCalls, 2, 'token refetched after invalidation');
});
