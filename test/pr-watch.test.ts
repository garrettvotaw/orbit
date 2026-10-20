import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeLines, diffFacts, parseWatchList, PrWatcher, type PrFacts } from '../src/main/pr-watch.ts';
import type { MonitorConfig } from '../src/shared/types.ts';

const REPO = 'contoso/storefront';
const facts = (over: Partial<PrFacts> & { number: number }): PrFacts => ({
  repo: REPO,
  title: `PR ${over.number}`,
  draft: false,
  updatedAt: 100,
  head: 'aaa',
  checks: 'pending',
  conflicting: false,
  decision: 'none',
  ...over,
});
const map = (...list: PrFacts[]) => new Map(list.map((f) => [`${f.repo}#${f.number}`, f]));
const change = (number: number, what: string, repo = REPO) => ({ repo, number, title: `PR ${number}`, what });

test('parseWatchList reads the gh fields into facts keyed by repo and number, and shrugs at bad json', () => {
  const json = JSON.stringify([
    {
      number: 7117,
      title: 'Bundle-only visit',
      isDraft: false,
      updatedAt: '2026-10-06T10:00:00Z',
      headRefOid: 'abc',
      mergeStateStatus: 'CONFLICTING',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    },
    { number: 'x' },
  ]);
  const got = parseWatchList(json, REPO);
  assert.deepEqual([...got.keys()], [`${REPO}#7117`]);
  assert.deepEqual(got.get(`${REPO}#7117`), {
    repo: REPO,
    number: 7117,
    title: 'Bundle-only visit',
    draft: false,
    updatedAt: Date.parse('2026-10-06T10:00:00Z'),
    head: 'abc',
    checks: 'failure',
    conflicting: true,
    decision: 'approved',
  });
  assert.equal(parseWatchList('nope', REPO).size, 0);
});

test('diffFacts names the moves the monitor acts on and nothing else', () => {
  const prev = map(
    facts({ number: 1, checks: 'pending' }),
    facts({ number: 2, checks: 'success' }),
    facts({ number: 3 }),
    facts({ number: 4, draft: true }),
    facts({ number: 5 }),
    facts({ number: 6, decision: 'review-required' }),
    facts({ number: 7 }),
    facts({ number: 8, checks: 'pending' }),
  );
  const next = map(
    facts({ number: 1, checks: 'failure' }),
    facts({ number: 2, head: 'bbb', checks: 'pending' }),
    facts({ number: 3, conflicting: true, updatedAt: 200 }),
    facts({ number: 4, draft: false }),
    facts({ number: 6, decision: 'approved' }),
    facts({ number: 7, updatedAt: 200 }),
    facts({ number: 8, checks: 'none' }),
    facts({ number: 9 }),
  );
  assert.deepEqual(diffFacts(prev, next), [
    change(1, 'CI went red'),
    change(2, 'new commits'),
    change(3, 'now conflicting'),
    change(4, 'ready for review'),
    change(5, 'closed or merged'),
    change(6, 'approved'),
    change(7, 'new comment or review'),
    change(9, 'opened'),
  ]);
  assert.deepEqual(diffFacts(next, next), []);
});

test('diffFacts leaves drafts alone both ways', () => {
  const prev = map(facts({ number: 1, draft: true, checks: 'pending' }), facts({ number: 2 }));
  const next = map(facts({ number: 1, draft: true, checks: 'failure' }), facts({ number: 2, draft: true }));
  assert.deepEqual(diffFacts(prev, next), [change(2, 'back to draft')]);
  assert.deepEqual(diffFacts(map(facts({ number: 1, draft: true })), map()), []);
});

test('the same PR number in two repos is two PRs', () => {
  const prev = map(facts({ number: 12 }), facts({ number: 12, repo: 'contoso/wallet' }));
  const next = map(facts({ number: 12, repo: 'contoso/wallet', head: 'bbb' }));
  assert.deepEqual(diffFacts(prev, next), [
    change(12, 'closed or merged'),
    change(12, 'new commits', 'contoso/wallet'),
  ]);
});

test('a single repo’s change lines read exactly as before', () => {
  assert.deepEqual(changeLines([{ repo: REPO, number: 7, title: 'Fix it', what: 'CI went green, approved' }]), [
    '- #7 Fix it: CI went green, approved',
  ]);
});

test('change lines name the repo once changes span two repos', () => {
  assert.deepEqual(changeLines([change(7, 'opened'), change(7, 'CI went red', 'contoso/wallet')]), [
    '- contoso/storefront#7 PR 7: opened',
    '- contoso/wallet#7 PR 7: CI went red',
  ]);
});

const prs: MonitorConfig = { id: 'prs', name: 'PRs', skill: 'monitor-prs', cwd: 'c', everyMinutes: 60, stateFile: 'x' };

/** Each gh pr list answers from that repo's pages in turn; `repo view` answers with the folder's repo. */
function harness(pages: Record<string, string[]>) {
  const calls: string[][] = [];
  const changes: Array<[string, string]> = [];
  const errors: string[] = [];
  const at: Record<string, number> = {};
  const w = new PrWatcher({
    gh: async (args) => {
      calls.push(args);
      if (args[0] === 'repo') return 'contoso/core\n';
      const repo = args[args.indexOf('-R') + 1];
      const list = pages[repo] ?? ['[]'];
      const i = at[repo] ?? 0;
      at[repo] = i + 1;
      const page = list[Math.min(i, list.length - 1)];
      if (page === 'ERR') throw new Error('gh: boom');
      return page;
    },
    onChange: (id, c) => changes.push([id, changeLines(c).join('|')]),
    onError: (_id, m) => errors.push(m),
  });
  return { w, calls, changes, errors };
}

const page = (...list: Array<Record<string, unknown>>) => JSON.stringify(list);
const red = { status: 'COMPLETED', conclusion: 'FAILURE' };

test('the first poll is a baseline; later polls report movement; a failed poll is only an error', async () => {
  const h = harness({
    'contoso/core': [
      page({ number: 1, title: 'A', headRefOid: 'a', statusCheckRollup: [{ status: 'IN_PROGRESS' }] }),
      page({ number: 1, title: 'A', headRefOid: 'a', statusCheckRollup: [red] }),
      'ERR',
      page({ number: 1, title: 'A', headRefOid: 'a', statusCheckRollup: [red] }),
    ],
  });
  h.w.setMonitors([prs], async () => []);
  await h.w.poll('prs');
  assert.deepEqual(h.changes, []);
  assert.deepEqual(h.calls[0].slice(0, 2), ['repo', 'view'], 'with no repos given, detects one from the lane folder');
  assert.ok(h.calls[1].includes('@me') && h.calls[1].includes('contoso/core'));
  await h.w.poll('prs');
  assert.deepEqual(h.changes, [['prs', '- #1 A: CI went red']]);
  await h.w.poll('prs');
  assert.deepEqual(h.errors, ['contoso/core: gh: boom']);
  await h.w.poll('prs');
  assert.equal(h.changes.length, 1, 'no change after the error');
  h.w.stop();
});

test('setMonitors honours watchSeconds 0 and the repos it is given', async () => {
  const h = harness({ 'Org/repo': [page()] });
  h.w.setMonitors([{ ...prs, watchSeconds: 0 }], async () => ['Org/repo']);
  await h.w.poll('prs');
  assert.deepEqual(h.calls, []);
  h.w.setMonitors([prs], async () => ['Org/repo']);
  await h.w.poll('prs');
  assert.ok(h.calls.every((c) => c[0] !== 'repo'));
  assert.ok(h.calls.some((c) => c.includes('Org/repo')));
  h.w.stop();
});

test('two repos: a change in one ticks, and a repo that fails is not read as everything closing', async () => {
  const pr = { number: 7, title: 'A', headRefOid: 'a' };
  const h = harness({
    'contoso/storefront': [page(pr), page(pr), page(pr)],
    'contoso/wallet': [page(pr), page({ ...pr, headRefOid: 'b' }), 'ERR'],
  });
  h.w.setMonitors([prs], async () => ['contoso/storefront', 'contoso/wallet']);
  await h.w.poll('prs');
  await h.w.poll('prs');
  assert.deepEqual(h.changes, [['prs', '- #7 A: new commits']], 'one repo moved, so the line needs no repo');
  await h.w.poll('prs');
  assert.equal(h.changes.length, 1, 'the wallet failure keeps its last facts');
  assert.deepEqual(h.errors, ['contoso/wallet: gh: boom']);
  h.w.stop();
});

test('a failed first poll is no baseline: the next good poll is, and only real moves tick after it', async () => {
  const pr = { number: 7, title: 'A', headRefOid: 'a' };
  const h = harness({ 'contoso/storefront': ['ERR', page(pr), page({ ...pr, headRefOid: 'b' })] });
  h.w.setMonitors([prs], async () => ['contoso/storefront']);
  await h.w.poll('prs');
  await h.w.poll('prs');
  assert.deepEqual(h.changes, [], 'the first good poll only sets the baseline');
  await h.w.poll('prs');
  assert.deepEqual(h.changes, [['prs', '- #7 A: new commits']]);
  h.w.stop();
});

test('a repo whose first poll failed gets its own baseline later instead of ticking every PR as opened', async () => {
  const pr = { number: 7, title: 'A', headRefOid: 'a' };
  const h = harness({
    'contoso/storefront': [page(pr), page(pr), page(pr)],
    'contoso/wallet': ['ERR', page(pr), page({ ...pr, headRefOid: 'b' })],
  });
  h.w.setMonitors([prs], async () => ['contoso/storefront', 'contoso/wallet']);
  await h.w.poll('prs');
  await h.w.poll('prs');
  assert.deepEqual(h.changes, [], 'wallet answering for the first time is its baseline');
  await h.w.poll('prs');
  assert.deepEqual(h.changes, [['prs', '- #7 A: new commits']]);
  h.w.stop();
});
