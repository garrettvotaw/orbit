import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMerged,
  GitHubPrs,
  MERGED_PRS_QUERY,
  parseMergedPage,
  TEAM_PRS_QUERY,
  parsePrList,
  rollupChecks,
  summarizeChecks,
} from '../src/main/github.ts';

/** A pull request as the Reviews query returns it. */
const node = (p: Record<string, unknown>) => ({
  url: `https://github.com/contoso/storefront/pull/${p.number}`,
  headRefName: '',
  additions: 0,
  deletions: 0,
  reviewRequests: { nodes: [] },
  commits: { nodes: [] },
  ...p,
});
const rollup = (state: string | null) => ({ nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] });

const sample = JSON.stringify({
  data: {
    repository: {
      pullRequests: {
        nodes: [
          node({
            number: 7127,
            title: 'AB#100136 gate cart return',
            author: { login: 'dustinbrantley' },
            isDraft: false,
            reviewDecision: 'REVIEW_REQUIRED',
            commits: rollup('PENDING'),
            updatedAt: '2026-10-06T20:26:48Z',
            reviewRequests: {
              nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'ea-truck-care-code-reviewers' } }],
            },
            headRefName: 'users/dustinb/100136',
            additions: 58,
            deletions: 6,
          }),
          node({
            number: 7123,
            title: 'Mine',
            author: { login: 'PatDoe' },
            isDraft: false,
            reviewDecision: 'APPROVED',
            commits: rollup('SUCCESS'),
            updatedAt: '2026-10-06T19:00:00Z',
          }),
          node({
            number: 7124,
            title: 'Draft',
            author: { login: 'someone' },
            isDraft: true,
            updatedAt: '2026-10-06T19:00:00Z',
          }),
          node({
            number: 7116,
            title: 'Asked of me',
            author: { login: 'markyd' },
            isDraft: false,
            reviewDecision: 'CHANGES_REQUESTED',
            commits: rollup('FAILURE'),
            updatedAt: '2026-10-05T10:00:00Z',
            reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'patdoe' } }] },
          }),
          node({
            number: 7110,
            title: 'Approved already',
            author: null,
            isDraft: false,
            reviewDecision: 'APPROVED',
            commits: rollup(null),
            updatedAt: '2026-10-06T21:00:00Z',
          }),
        ],
      },
    },
  },
});

test('parsePrList drops mine and drafts, maps decision, checks, and requests, and ranks what needs eyes', () => {
  const prs = parsePrList(sample, 'patdoe', 'contoso/storefront');
  assert.deepEqual(
    prs.map((p) => p.number),
    [7116, 7127, 7110],
    'asked of me first, then team-requested, then the rest',
  );
  const asked = prs[0];
  assert.equal(asked.requested, 'you');
  assert.equal(asked.decision, 'changes-requested');
  assert.equal(asked.checks, 'failure');
  const team = prs[1];
  assert.equal(team.requested, 'team');
  assert.equal(team.checks, 'pending');
  assert.equal(team.branch, 'users/dustinb/100136');
  assert.equal(team.additions, 58);
  assert.equal(team.url, 'https://github.com/contoso/storefront/pull/7127');
  assert.equal(team.updatedAt, Date.parse('2026-10-06T20:26:48Z'));
  assert.equal(prs[2].checks, 'none', 'no checks at all');
  assert.equal(prs[2].requested, null);
  assert.equal(prs[2].author, '', 'a deleted account has no author');
  assert.deepEqual(parsePrList('{bad', 'me', 'r/x'), []);
  assert.deepEqual(parsePrList('{"data":null}', 'me', 'r/x'), []);
});

test('rollupChecks reads the one state GitHub rolls a head commit up to', () => {
  assert.equal(rollupChecks('SUCCESS'), 'success');
  assert.equal(rollupChecks('FAILURE'), 'failure');
  assert.equal(rollupChecks('ERROR'), 'failure');
  assert.equal(rollupChecks('PENDING'), 'pending');
  assert.equal(rollupChecks('EXPECTED'), 'pending', 'a required check that has not reported yet');
  assert.equal(rollupChecks(null), 'none');
  assert.equal(rollupChecks(undefined), 'none');
});

test('summarizeChecks reads rollup conclusions', () => {
  assert.equal(
    summarizeChecks([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
    ]),
    'success',
  );
  assert.equal(summarizeChecks([{ status: 'COMPLETED', conclusion: 'NEUTRAL' }]), 'none');
  assert.equal(summarizeChecks([{ status: 'QUEUED', conclusion: '' }]), 'pending');
  assert.equal(summarizeChecks([{ state: 'FAILURE' }]), 'failure', 'legacy StatusContext shape');
  assert.equal(summarizeChecks(undefined), 'none');
});

test('GitHubPrs asks each repo, learns who you are once, and keeps the last list on failure', async () => {
  const calls: string[][] = [];
  let fail = false;
  const gh = async (args: string[]) => {
    calls.push(args);
    if (fail) throw new Error('gh: network');
    if (args[0] === 'api' && args[1] === 'user') return 'patdoe\n';
    if (args[0] === 'api' && args[1] === 'graphql') return sample;
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const prs = new GitHubPrs(
    () => {},
    gh,
    () => 7,
  );
  prs.configure({ repos: async () => ['contoso/storefront'], pollMinutes: 5 });
  await prs.refresh();
  prs.stop();
  assert.equal(prs.board().error, null);
  assert.deepEqual(prs.board().repos, ['contoso/storefront']);
  assert.equal(prs.board().prs.length, 3);
  assert.ok(prs.board().prs.every((p) => p.repo === 'contoso/storefront'));
  assert.equal(prs.board().fetchedAt, 7);
  // One lean query: the rollup's single state per PR, never every check run, which GitHub times out on.
  const query = calls.find((c) => c[1] === 'graphql')!;
  assert.ok(query.includes('owner=contoso') && query.includes('name=storefront'));
  assert.ok(query.includes(`query=${TEAM_PRS_QUERY}`));
  assert.match(TEAM_PRS_QUERY, /statusCheckRollup \{ state \}/);
  assert.doesNotMatch(TEAM_PRS_QUERY, /contexts|\n/);
  await prs.refresh();
  assert.equal(calls.filter((c) => c[1] === 'user').length, 1, 'login cached');
  fail = true;
  await prs.refresh();
  assert.equal(prs.board().prs.length, 3, 'last good list kept');
  assert.match(prs.board().error!, /contoso\/storefront: gh: network/);
});

const onePr = (number: number, requested: boolean) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number,
              title: `PR ${number}`,
              url: `u/${number}`,
              isDraft: false,
              updatedAt: '2026-10-10T00:00:00Z',
              author: { login: 'sam' },
              reviewDecision: 'REVIEW_REQUIRED',
              reviewRequests: { nodes: requested ? [{ requestedReviewer: { __typename: 'User', login: 'pat' } }] : [] },
            },
          ],
        },
      },
    },
  });

test('GitHubPrs merges and ranks PRs from two repos and tags each with its repo', async () => {
  const gh = async (args: string[]) => {
    if (args[1] === 'user') return 'pat\n';
    return args.includes('name=wallet') ? onePr(12, true) : onePr(12, false);
  };
  const prs = new GitHubPrs(() => {}, gh);
  prs.configure({ repos: async () => ['contoso/storefront', 'contoso/wallet'] });
  await prs.refresh();
  prs.stop();
  assert.deepEqual(prs.board().repos, ['contoso/storefront', 'contoso/wallet']);
  assert.deepEqual(
    prs.board().prs.map((p) => [p.repo, p.number, p.requested]),
    [
      ['contoso/wallet', 12, 'you'],
      ['contoso/storefront', 12, null],
    ],
  );
});

test('a repo that fails leaves the other repo PRs and names the failing repo in error', async () => {
  const gh = async (args: string[]) => {
    if (args[1] === 'user') return 'pat\n';
    if (args.includes('name=wallet')) throw new Error('gh: HTTP 404');
    return onePr(3, false);
  };
  const prs = new GitHubPrs(() => {}, gh);
  prs.configure({ repos: async () => ['contoso/storefront', 'contoso/wallet'] });
  await prs.refresh();
  prs.stop();
  assert.deepEqual(
    prs.board().prs.map((p) => [p.repo, p.number]),
    [['contoso/storefront', 3]],
  );
  assert.equal(prs.board().error, 'contoso/wallet: gh: HTTP 404');
});

const mergedPage = (nodes: unknown[], next: string | null) =>
  JSON.stringify({
    data: { search: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } },
  });

test('parseMergedPage keeps merged PRs with their merge time, branch, and body, and the cursor for the next page', () => {
  const page = parseMergedPage(
    mergedPage(
      [
        {
          number: 7163,
          title: 'ACME-12 Payment',
          url: 'https://github.com/o/r/pull/7163',
          mergedAt: '2026-10-13T19:04:00Z',
          headRefName: 'users/pat/ACME-12-payment',
          body: 'Closes ACME-12.',
        },
        { number: 7164, title: 'never merged', url: 'u', mergedAt: null },
        {},
      ],
      'Y3Vy',
    ),
  );
  assert.deepEqual(page, {
    prs: [
      {
        number: 7163,
        title: 'ACME-12 Payment',
        url: 'https://github.com/o/r/pull/7163',
        mergedAt: Date.parse('2026-10-13T19:04:00Z'),
        branch: 'users/pat/ACME-12-payment',
        body: 'Closes ACME-12.',
      },
    ],
    next: 'Y3Vy',
  });
  assert.equal(parseMergedPage(mergedPage([], null)).next, null);
});

test('fetchMerged searches the repo for PRs merged since the day, page by page, in one-line queries', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    const after = args.find((a) => a.startsWith('after='));
    return after
      ? mergedPage([{ number: 2, title: 'b', url: 'u2', mergedAt: '2026-10-02T00:00:00Z' }], null)
      : mergedPage([{ number: 1, title: 'a', url: 'u1', mergedAt: '2026-10-01T00:00:00Z' }], 'next1');
  };
  const prs = await fetchMerged(gh, 'contoso/storefront', '2026-09-09');
  assert.deepEqual(
    prs.map((p) => p.number),
    [1, 2],
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('q=repo:contoso/storefront is:pr is:merged merged:>=2026-09-09'));
  assert.ok(calls[0].includes(`query=${MERGED_PRS_QUERY}`));
  assert.ok(!calls[0].some((a) => a.startsWith('after=')), 'the first page has no cursor');
  assert.ok(calls[1].includes('after=next1'));
  assert.doesNotMatch(MERGED_PRS_QUERY, /\n/);
});
