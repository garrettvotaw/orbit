import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdoClient, AdoTokenProvider } from '../src/main/trackers/ado.ts';
import { JiraClient } from '../src/main/trackers/jira.ts';
import { TrackerPoller } from '../src/main/trackers/poller.ts';
import { TrackerRegistry } from '../src/main/trackers/registry.ts';
import { TrackerAuthError, type Tracker } from '../src/main/trackers/tracker.ts';
import type { BoardColumn, ProjectConfig, TrackerItem, TrackerRef } from '../src/shared/types.ts';

const project = (id: string, extra: Partial<ProjectConfig> = {}): ProjectConfig => ({
  id,
  name: id,
  agent: 'pm',
  cwd: '.',
  kickoff: 'go',
  ...extra,
});
const item = (id: string): TrackerItem => ({
  id,
  key: id,
  title: id,
  type: 'Story',
  column: 'Doing',
  stage: 'building',
  assignedTo: null,
  parentId: null,
  prs: [],
  url: '',
  sprint: null,
});
const columns: BoardColumn[] = [{ name: 'Doing', stage: 'building', color: '#2fb344' }];
const ADO: TrackerRef = { kind: 'ado', site: 'contoso' };
const JIRA: TrackerRef = { kind: 'jira', site: 'contoso.atlassian.net' };

/** A tracker whose board() returns its items, or throws whatever `fail` holds at the time. */
function fake(ref: TrackerRef, items: TrackerItem[]) {
  const t = {
    ref,
    fail: null as Error | null,
    calls: 0,
    board: async () => {
      t.calls++;
      if (t.fail) throw t.fail;
      return { columns, items };
    },
  };
  return t;
}

function poller(trackers: Record<string, ReturnType<typeof fake>>) {
  const auth: Array<[string, TrackerRef, string]> = [];
  const timers: Array<() => void> = [];
  const p = new TrackerPoller({
    trackers: { for: (id) => (trackers[id] as unknown as Tracker) ?? null },
    now: () => 42,
    setInterval: ((fn: () => void) => {
      timers.push(fn);
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearInterval: () => {},
    onAuthError: (projectId, ref, message) => auth.push([projectId, ref, message]),
    onBoards: () => {},
  });
  return { p, auth, timers };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('keeps the last good items on failure, marks stale, and raises auth once per outage', async () => {
  const shop = fake(ADO, [item('1301')]);
  const { p, auth, timers } = poller({ shop });
  p.setProjects([project('shop')], 2);
  await settle();
  let b = p.boards()[0];
  assert.deepEqual([b.items.length, b.stale, b.fetchedAt, b.tracker, b.columns], [1, false, 42, ADO, columns]);

  shop.fail = new TrackerAuthError(ADO, 'ADO 401');
  await p.refresh('shop');
  await p.refresh('shop');
  b = p.boards()[0];
  assert.equal(b.items.length, 1, 'previous items kept');
  assert.equal(b.stale, true);
  assert.equal(b.error, 'ADO 401');
  assert.deepEqual(auth, [['shop', ADO, 'ADO 401']], 'raised once while the outage lasts');

  shop.fail = null;
  await p.refresh('shop');
  assert.equal(p.boards()[0].stale, false);
  shop.fail = new TrackerAuthError(ADO, 'ADO 401 again');
  await p.refresh('shop');
  assert.equal(auth.length, 2, 'a new outage raises again');
  assert.equal(timers.length, 1);
});

test('a failing tracker marks only its own board stale while the others refresh', async () => {
  const shop = fake(ADO, [item('1')]);
  const cart = fake(JIRA, [item('ACME-1')]);
  const { p, auth } = poller({ shop, cart });
  p.setProjects([project('shop'), project('cart')], 2);
  await settle();
  cart.fail = new Error('Jira 404: board 99 not found');
  await p.refreshAll();
  const [s, c] = p.boards();
  assert.deepEqual([s.stale, s.error, s.items.length], [false, null, 1]);
  assert.deepEqual([c.stale, c.error, c.items.length], [true, 'Jira 404: board 99 not found', 1]);
  assert.deepEqual(auth, [], 'a broken board is not a sign-in problem');
});

test('two refs signed out raise one card each, on the first project using it; a success re-arms only its own ref', async () => {
  const a = fake(ADO, []);
  const b = fake(JIRA, []);
  const c = fake(JIRA, []);
  const { p, auth } = poller({ a, b, c });
  p.setProjects([project('a'), project('b'), project('c')], 2);
  await settle();
  a.fail = new TrackerAuthError(ADO, 'ADO 401');
  b.fail = c.fail = new TrackerAuthError(JIRA, 'Jira 401');
  await p.refresh('c');
  await p.refresh('b');
  await p.refresh('a');
  assert.deepEqual(auth, [
    ['b', JIRA, 'Jira 401'],
    ['a', ADO, 'ADO 401'],
  ]);
  a.fail = null;
  await p.refresh('a');
  await p.refresh('b');
  assert.equal(auth.length, 2, 'Jira is still out and already raised');
  a.fail = new TrackerAuthError(ADO, 'ADO 401 again');
  await p.refresh('a');
  assert.deepEqual(auth.at(-1), ['a', ADO, 'ADO 401 again']);
});

test('a project with no tracker gets an empty board and no fetch', async () => {
  const { p } = poller({});
  p.setProjects([project('plain')], 2);
  await settle();
  assert.deepEqual(p.boards(), [
    { projectId: 'plain', tracker: null, fetchedAt: 0, columns: [], items: [], stale: false, error: null },
  ]);
  assert.equal(p.board('plain')?.tracker, null);
  assert.equal(p.board('missing'), null);
});

test('registry.setProjects keeps the same adapter when a project tracker config is unchanged', () => {
  const reg = new TrackerRegistry({
    ado: new AdoClient(new AdoTokenProvider(async () => '{}')),
    jira: (site) => new JiraClient(site, () => null),
    gh: async () => '',
  });
  const legacy = project('shop', { ado: { org: 'contoso', project: 'Storefront', anchorId: 1 } });
  const jira = project('cart', {
    tracker: { kind: 'jira', site: 'contoso.atlassian.net', projectKey: 'ACME', board: 42, epic: 'ACME-1' },
  });
  reg.setProjects([legacy, jira, project('plain')]);
  const first = [reg.for('shop'), reg.for('cart')];
  assert.deepEqual(
    first.map((t) => t?.ref),
    [ADO, JIRA],
  );
  assert.equal(reg.for('plain'), null);
  reg.setProjects([legacy, { ...jira, tracker: { ...jira.tracker!, board: 43 } as ProjectConfig['tracker'] }]);
  assert.equal(reg.for('shop'), first[0], 'unchanged config keeps its adapter');
  assert.notEqual(reg.for('cart'), first[1], 'a changed config rebuilds');
});

test('forget(ref) lets a sign-in that fails again raise its card again', async () => {
  const cart = fake(JIRA, []);
  const { p, auth } = poller({ cart });
  p.setProjects([project('cart')], 2);
  await settle();
  cart.fail = new TrackerAuthError(JIRA, 'No Jira sign-in for contoso.atlassian.net');
  await p.refresh('cart');
  assert.equal(auth.length, 1);
  p.forget(JIRA);
  cart.fail = new TrackerAuthError(JIRA, 'Jira 401: sign-in rejected for contoso.atlassian.net');
  await p.refresh('cart');
  assert.deepEqual(auth.at(-1), ['cart', JIRA, 'Jira 401: sign-in rejected for contoso.atlassian.net']);
});
