import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf, sprintSky, windowOf } from '../src/main/sprints.ts';
import { StarWatcher } from '../src/main/stars.ts';
import type { Tracker } from '../src/main/trackers/tracker.ts';
import type { ProjectConfig, SprintWindow, Star, TrackerItem } from '../src/shared/types.ts';

const day = (m: number, d: number) => new Date(2026, m - 1, d).getTime();
const sprint = (name: string, start: number, finish: number): SprintWindow => ({
  name,
  path: `Storefront\\${name}`,
  start,
  finish,
});
const vigilante = sprint('Sprint 13 (9.9 - 9.29)', day(9, 9), day(9, 30));
const wrecking = sprint('Sprint 14 (9.30 - 10.20)', day(9, 30), day(10, 21));
const xevious = sprint('Sprint 15 (10.21 - 11.10)', day(10, 21), day(11, 11));
const windows = [xevious, vigilante, wrecking];

test('the current sprint holds now, and the previous is the last one that ended before it began', () => {
  assert.deepEqual(sprintSky(windows, day(10, 14)), { current: wrecking, previous: vigilante });
  assert.deepEqual(sprintSky(windows, day(9, 30)), { current: wrecking, previous: vigilante }, 'first day');
  assert.deepEqual(sprintSky(windows, day(10, 21) - 1), { current: wrecking, previous: vigilante }, 'last moment');
  assert.deepEqual(sprintSky(windows, day(10, 21)), { current: xevious, previous: wrecking });
});

test('between sprints there is no current one, and the one that just ended is the previous', () => {
  const gap = [vigilante, sprint('Later', day(10, 1), day(10, 20))];
  assert.deepEqual(sprintSky(gap, day(9, 30)), { current: null, previous: vigilante });
  assert.deepEqual(sprintSky([], day(9, 30)), { current: null, previous: null });
});

test('a merge belongs to the sprint whose window holds it', () => {
  assert.equal(windowOf(windows, day(10, 14) + 3_600_000), wrecking);
  assert.equal(windowOf(windows, day(9, 29) + 23 * 3_600_000), vigilante, 'late on the last day');
  assert.equal(windowOf(windows, day(1, 1)), null);
});

test('dayOf writes a local date the way WIQL and GitHub search take it', () => {
  assert.equal(dayOf(day(9, 9)), '2026-09-09');
  assert.equal(dayOf(day(10, 21) + 5 * 3_600_000), '2026-10-21');
});

const cfg = (id: string): ProjectConfig => ({ id, name: id, agent: `${id}-pm`, cwd: 'c', kickoff: 'go' });
const item = (id: string, prs: number[]): TrackerItem => ({
  id,
  key: id,
  title: `Story ${id}`,
  type: 'User Story',
  column: 'Closed',
  stage: 'done',
  assignedTo: null,
  parentId: null,
  prs: prs.map((number) => ({ repo: null, number })),
  url: `u/${id}`,
  sprint: null,
});
const pr = (number: number, mergedAt: number) => ({
  number,
  title: 't',
  url: `https://github.com/o/r/pull/${number}`,
  mergedAt,
  branch: '',
  body: '',
});

test('StarWatcher reads each PM’s sprints and shipped stories, and the PRs merged since its last sprint began', async () => {
  const calls: string[] = [];
  const found: Star[][] = [];
  const tracker = (id: string, items: TrackerItem[]) =>
    ({
      ref: { kind: 'ado', site: 'contoso' },
      sprints: async () => {
        calls.push(`sprints ${id}`);
        return windows;
      },
      shipped: async (since: string) => {
        calls.push(`shipped ${id} ${since}`);
        return items;
      },
    }) as unknown as Tracker;
  const trackers: Record<string, Tracker> = {
    shop: tracker('shop', [item('1301', [7163])]),
    cart: tracker('cart', [item('1304', [7164])]),
  };
  const watcher = new StarWatcher({
    trackers: { for: (id) => trackers[id] ?? null },
    repos: { repoFor: async () => 'o/r' },
    merged: async (repo, since) => {
      calls.push(`merged ${repo} ${since}`);
      return [pr(7163, day(10, 13)), pr(7164, day(9, 20))];
    },
    moonPrs: () => [],
    now: () => day(10, 14),
    onStars: (stars) => found.push(stars),
  });
  watcher.setProjects([cfg('shop'), cfg('cart')]);
  await watcher.refresh();
  assert.deepEqual(calls.sort(), [
    'merged o/r 2026-09-09',
    'shipped cart 2026-09-09',
    'shipped shop 2026-09-09',
    'sprints cart',
    'sprints shop',
  ]);
  assert.deepEqual(watcher.skies().shop, { current: wrecking, previous: vigilante });
  assert.deepEqual(
    found[0].map((s) => [s.id, s.sprint]),
    [
      ['cart-pr-7164', vigilante.path],
      ['shop-pr-7163', wrecking.path],
    ],
  );
});

test('StarWatcher keeps a PM’s last sky when its sprints fail, and waits for a repo before asking GitHub', async () => {
  let fail = false;
  let repo: string | null = null;
  const merged: string[] = [];
  const errors: string[] = [];
  const shop = {
    ref: { kind: 'ado', site: 'contoso' },
    sprints: async () => {
      if (fail) throw new Error('ADO 500');
      return windows;
    },
    shipped: async () => [],
  } as unknown as Tracker;
  const watcher = new StarWatcher({
    trackers: { for: (id) => (id === 'shop' ? shop : null) },
    repos: { repoFor: async () => repo },
    merged: async (r) => {
      merged.push(r);
      return [];
    },
    moonPrs: () => [],
    now: () => day(10, 14),
    onStars: () => {},
    onError: (m) => errors.push(m),
  });
  watcher.setProjects([cfg('shop')]);
  await watcher.refresh();
  assert.deepEqual(merged, [], 'no repo yet');
  assert.equal(watcher.skies().shop.current, wrecking, 'the sky still comes from the tracker');
  fail = true;
  repo = 'o/r';
  await watcher.refresh();
  assert.equal(watcher.skies().shop.current, wrecking, 'kept through the failure');
  assert.deepEqual(errors, ['shop: ADO 500']);
});
