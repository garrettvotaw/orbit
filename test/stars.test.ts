import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/main/db.ts';
import type { MergedPr } from '../src/main/github.ts';
import { StarStore, StarWatcher, starsFor } from '../src/main/stars.ts';
import type { Tracker } from '../src/main/trackers/tracker.ts';
import type { PrRef, SprintWindow, Star, TrackerItem, TrackerRef } from '../src/shared/types.ts';

const day = (m: number, d: number) => new Date(2026, m - 1, d).getTime();
const s13: SprintWindow = { name: 'Sprint 13', path: 'Storefront\\Sprint 13', start: day(9, 9), finish: day(9, 30) };
const s14: SprintWindow = { name: 'Sprint 14', path: 'Storefront\\Sprint 14', start: day(9, 30), finish: day(10, 21) };
const item = (id: string, prs: number[] | PrRef[] = []): TrackerItem => ({
  id,
  key: id,
  title: `Story ${id}`,
  type: 'User Story',
  column: 'QA',
  stage: 'testing',
  assignedTo: null,
  parentId: null,
  prs: (prs as Array<number | PrRef>).map((p) => (typeof p === 'number' ? { repo: null, number: p } : p)),
  url: `u/${id}`,
  sprint: null,
});
const pr = (number: number, mergedAt: number, extra: Partial<MergedPr> = {}): MergedPr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/contoso/storefront/pull/${number}`,
  mergedAt,
  branch: `users/pat/${number}`,
  body: '',
  ...extra,
});
const star = (id: string, sprint: string | null, at: number): Star => ({
  id: `shop-pr-${id}`,
  pmId: 'shop',
  storyId: id,
  title: id,
  pr: 1,
  prUrl: null,
  sprint,
  at,
});

test('a merged PR linked to a story is one star, stamped when it merged, in the sprint it merged in', () => {
  const made = starsFor(
    'shop',
    [item('1301', [7157, 7163]), item('1302', [7167])],
    [pr(7163, day(10, 13)), pr(7136, day(9, 20))],
    [s13, s14],
    [],
    false,
  );
  assert.deepEqual(made, [
    {
      id: 'shop-pr-7163',
      pmId: 'shop',
      storyId: '1301',
      title: 'Story 1301',
      pr: 7163,
      prUrl: 'https://github.com/contoso/storefront/pull/7163',
      sprint: 'Storefront\\Sprint 14',
      at: day(10, 13),
    },
  ]);
});

test('the merge date decides the sprint', () => {
  const made = starsFor('cart', [item('1401', [7160])], [pr(7160, day(9, 25))], [s13, s14], [], false);
  assert.equal(made[0].sprint, 'Storefront\\Sprint 13');
});

test('a merge outside every sprint, or on nobody’s story, makes no star', () => {
  assert.deepEqual(starsFor('shop', [item('1', [10])], [pr(10, day(1, 2)), pr(11, day(10, 1))], [s14], [], false), []);
});

test('with no sprint windows at all a merge is still a star, with no sprint', () => {
  const made = starsFor('shop', [item('45', [10])], [pr(10, day(1, 2))], [], [], false);
  assert.deepEqual(
    made.map((s) => [s.storyId, s.sprint]),
    [['45', null]],
  );
});

test('a PR linked from two stories is one star on the lower id', () => {
  const made = starsFor(
    'shop',
    [item('9', [7]), item('10', [7]), item('5', [7])],
    [pr(7, day(10, 2))],
    [s14],
    [],
    false,
  );
  assert.deepEqual(
    made.map((s) => [s.id, s.storyId]),
    [['shop-pr-7', '5']],
  );
});

test('a Jira key in the PR title, branch, or body links it only when linkByKey is set, and only as a whole token', () => {
  const items = [item('ACME-12'), item('ACME-123')];
  const merged = [
    pr(1, day(10, 2), { title: 'ACME-12: saved cards' }),
    pr(2, day(10, 3), { branch: 'users/pat/ACME-123-wallet' }),
    pr(3, day(10, 4), { body: 'Closes ACME-12.' }),
  ];
  assert.deepEqual(starsFor('cart', items, merged, [s14], [], false), []);
  assert.deepEqual(
    starsFor('cart', items, merged, [s14], [], true).map((s) => [s.pr, s.storyId]),
    [
      [1, 'ACME-12'],
      [2, 'ACME-123'],
      [3, 'ACME-12'],
    ],
  );
});

test('a PR a story moon opened links to that story', () => {
  const made = starsFor(
    'shop',
    [item('1301'), item('1302')],
    [pr(41, day(10, 2))],
    [s14],
    [{ storyId: '1302', pr: 41 }],
    false,
  );
  assert.deepEqual(
    made.map((s) => s.storyId),
    ['1302'],
  );
});

test('a tracker link to the same number in another repo is not this PR', () => {
  const made = starsFor(
    'shop',
    [item('45', [{ repo: 'contoso/other', number: 7 }])],
    [pr(7, day(10, 2))],
    [s14],
    [],
    false,
  );
  assert.deepEqual(made, []);
});

/** A tracker that only answers the star watcher's two questions. */
const fakeTracker = (ref: TrackerRef, windows: SprintWindow[], items: TrackerItem[]) =>
  ({ ref, sprints: async () => windows, shipped: async () => items }) as unknown as Tracker;

test('StarWatcher gives each PM its own sky and asks GitHub once per repo, from the earliest sprint start', async () => {
  const trackers: Record<string, Tracker> = {
    shop: fakeTracker({ kind: 'ado', site: 'contoso' }, [s13, s14], [item('1301', [7163])]),
    cart: fakeTracker({ kind: 'jira', site: 'contoso.atlassian.net' }, [s14], [item('ACME-1')]),
    wallet: fakeTracker({ kind: 'github', site: 'github.com' }, [], [item('45', [9])]),
  };
  const repos: Record<string, string> = {
    shop: 'contoso/storefront',
    cart: 'contoso/storefront',
    wallet: 'contoso/wallet',
  };
  const asked: Array<[string, string]> = [];
  let found: Star[] = [];
  const watcher = new StarWatcher({
    trackers: { for: (id) => trackers[id] ?? null },
    repos: { repoFor: async (id) => repos[id] ?? null },
    merged: async (repo, since) => {
      asked.push([repo, since]);
      return repo === 'contoso/wallet'
        ? [pr(9, day(10, 5), { url: 'https://github.com/contoso/wallet/pull/9' })]
        : [pr(7163, day(10, 13)), pr(7164, day(10, 14), { title: 'ACME-1 done' })];
    },
    moonPrs: () => [],
    now: () => day(10, 15),
    onStars: (s) => (found = s),
  });
  const project = (id: string) => ({ id, name: id, agent: 'pm', cwd: '.', kickoff: 'go' });
  watcher.setProjects([project('shop'), project('cart'), project('wallet'), project('plain')]);
  await watcher.refresh();
  const skies = watcher.skies();
  assert.equal(skies.shop.current?.name, 'Sprint 14');
  assert.equal(skies.shop.previous?.name, 'Sprint 13');
  assert.equal(skies.cart.current?.name, 'Sprint 14');
  assert.equal(skies.cart.previous, null);
  assert.deepEqual(skies.wallet, { current: null, previous: null });
  assert.equal(skies.plain, undefined);
  assert.deepEqual(asked.sort(), [
    ['contoso/storefront', '2026-09-09'],
    ['contoso/wallet', '2026-09-03'],
  ]);
  assert.deepEqual(
    found.map((s) => [s.pmId, s.storyId, s.sprint]),
    [
      ['wallet', '45', null],
      ['shop', '1301', 'Storefront\\Sprint 14'],
      ['cart', 'ACME-1', 'Storefront\\Sprint 14'],
    ],
  );
});

test('stars live in the database and a second add of the same star changes nothing', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'orbit-stars-')), 'orbit.db');
  const store = new StarStore(openDb(file));
  let changes = 0;
  store.onChange(() => changes++);
  store.add([star('1', 'Sprint 41', 10), star('2', 'Sprint 41', 20)]);
  store.add([star('1', 'Sprint 41', 10)]);
  assert.equal(changes, 1, 'only a real addition tells anyone');
  assert.deepEqual(
    new StarStore(openDb(file)).list().map((s) => s.storyId),
    ['1', '2'],
  );
});
