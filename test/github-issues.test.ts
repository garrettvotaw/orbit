import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GhRunner } from '../src/main/github.ts';
import { GitHubIssuesAdapter, isGhAuthError } from '../src/main/trackers/github-issues.ts';
import { TrackerAuthError, TrackerMoveError } from '../src/main/trackers/tracker.ts';
import type { GitHubTrackerConfig } from '../src/shared/types.ts';

const projectCfg: GitHubTrackerConfig = {
  kind: 'github',
  repo: 'contoso/storefront',
  project: 7,
  iterationField: 'Sprint',
};
const labelCfg: GitHubTrackerConfig = { kind: 'github', repo: 'contoso/storefront', label: 'checkout' };

interface Call {
  args: string[];
  input?: string;
}

/** Answers each gh call with the first responder whose test matches the joined args; records every call. */
function fakeGh(responders: Array<[(joined: string) => boolean, (call: Call) => unknown]>) {
  const calls: Call[] = [];
  const gh: GhRunner = async (args, _cwd, input) => {
    const call = { args, input };
    calls.push(call);
    const joined = args.join(' ');
    const hit = responders.find(([match]) => match(joined));
    if (!hit) throw new Error(`gh: no fake for ${joined}`);
    const out = hit[1](call);
    return typeof out === 'string' ? out : JSON.stringify(out);
  };
  return { gh, calls };
}

const issueNode = (
  n: number,
  opts: { repo?: string; state?: string; prs?: Array<{ number: number; state?: string }> } = {},
) => ({
  __typename: 'Issue',
  number: n,
  title: `issue ${n}`,
  url: `https://github.com/contoso/storefront/issues/${n}`,
  state: opts.state ?? 'OPEN',
  updatedAt: '2026-10-10T00:00:00Z',
  assignees: { nodes: n % 2 ? [{ login: 'patdoe' }] : [] },
  repository: { nameWithOwner: opts.repo ?? 'contoso/storefront' },
  closedByPullRequestsReferences: {
    nodes: (opts.prs ?? []).map((p) => ({
      number: p.number,
      state: p.state ?? 'OPEN',
      repository: { nameWithOwner: 'contoso/storefront' },
    })),
  },
});

const statusField = {
  id: 'F_status',
  name: 'Status',
  options: [
    { id: 'o1', name: 'Todo' },
    { id: 'o2', name: 'Doing' },
    { id: 'o3', name: 'Shipped' },
  ],
};
const sprintField = {
  id: 'F_sprint',
  name: 'Sprint',
  configuration: {
    iterations: [{ title: 'Sprint 14', startDate: '2026-10-07', duration: 14 }],
    completedIterations: [{ title: 'Sprint 13', startDate: '2026-09-23', duration: 14 }],
  },
};

const projectItem = (id: string, content: unknown, status?: string, sprint?: string) => ({
  id,
  content,
  fieldValues: {
    nodes: [
      ...(status ? [{ name: status, optionId: 'x', field: { name: 'Status' } }] : []),
      ...(sprint ? [{ title: sprint, field: { name: 'Sprint' } }] : []),
    ],
  },
});

const projectPage = (items: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: {
    repositoryOwner: {
      projectV2: {
        id: 'P_7',
        fields: { nodes: [statusField, sprintField, { id: 'F_title', name: 'Title' }] },
        items: { pageInfo: { hasNextPage, endCursor }, nodes: items },
      },
    },
  },
});

const isProjectQuery = (j: string) => j.includes('projectV2(number');

test('project mode: columns follow the Status options, with positional stages when names do not say', async () => {
  const { gh } = fakeGh([[isProjectQuery, () => projectPage([projectItem('I1', issueNode(1), 'Doing', 'Sprint 14')])]]);
  const { columns, items } = await new GitHubIssuesAdapter(projectCfg, gh).board();
  assert.deepEqual(
    columns.map((c) => [c.name, c.stage]),
    [
      ['No Status', 'not-started'],
      ['Todo', 'not-started'],
      ['Doing', 'building'],
      ['Shipped', 'done'],
    ],
  );
  assert.deepEqual(items, [
    {
      id: '1',
      key: '#1',
      title: 'issue 1',
      type: 'Issue',
      column: 'Doing',
      stage: 'building',
      assignedTo: 'patdoe',
      parentId: null,
      prs: [],
      url: 'https://github.com/contoso/storefront/issues/1',
      sprint: 'Sprint 14',
    },
  ]);
});

test('project mode pages items until hasNextPage is false', async () => {
  const page = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => projectItem(`I${from + i}`, issueNode(from + i), 'Todo'));
  const { gh, calls } = fakeGh([
    [(j) => isProjectQuery(j) && j.includes('after=c1'), () => projectPage(page(101, 20))],
    [isProjectQuery, () => projectPage(page(1, 100), true, 'c1')],
  ]);
  const { items } = await new GitHubIssuesAdapter(projectCfg, gh).board();
  assert.equal(items.length, 120);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('number=7'), 'the project number goes as a typed -F field');
});

test('project mode drops pull requests, draft items, closed issues, and issues from other repos', async () => {
  const { gh } = fakeGh([
    [
      isProjectQuery,
      () =>
        projectPage([
          projectItem('I1', issueNode(1), 'Todo'),
          projectItem('I2', { __typename: 'PullRequest', number: 9 }, 'Doing'),
          projectItem('I3', { __typename: 'DraftIssue', title: 'idea' }, 'Todo'),
          projectItem('I4', issueNode(4, { repo: 'contoso/other' }), 'Todo'),
          projectItem('I5', issueNode(5, { state: 'CLOSED' }), 'Shipped'),
          projectItem('I6', issueNode(6, { prs: [{ number: 41 }] })),
        ]),
    ],
  ]);
  const { items } = await new GitHubIssuesAdapter(projectCfg, gh).board();
  assert.deepEqual(
    items.map((i) => [i.key, i.column]),
    [
      ['#1', 'Todo'],
      ['#6', 'No Status'],
    ],
  );
  assert.deepEqual(items[1].prs, [{ repo: 'contoso/storefront', number: 41 }]);
});

test('project mode sprints come from the named iteration field as local-midnight windows', async () => {
  const { gh } = fakeGh([[isProjectQuery, () => projectPage([])]]);
  const windows = await new GitHubIssuesAdapter(projectCfg, gh).sprints();
  assert.deepEqual(windows, [
    {
      name: 'Sprint 13',
      path: 'Sprint 13',
      start: new Date(2026, 8, 23).getTime(),
      finish: new Date(2026, 9, 7).getTime(),
    },
    {
      name: 'Sprint 14',
      path: 'Sprint 14',
      start: new Date(2026, 9, 7).getTime(),
      finish: new Date(2026, 9, 21).getTime(),
    },
  ]);
});

test('project mode move sends updateProjectV2ItemFieldValue with the option id for the stage', async () => {
  const { gh, calls } = fakeGh([
    [isProjectQuery, () => projectPage([projectItem('I1', issueNode(1), 'Todo')])],
    [(j) => j.includes('updateProjectV2ItemFieldValue'), () => ({ data: {} })],
  ]);
  const col = await new GitHubIssuesAdapter(projectCfg, gh).move('1', 'done');
  assert.equal(col.name, 'Shipped');
  const m = calls.find((c) => c.args.join(' ').includes('updateProjectV2ItemFieldValue'));
  assert.ok(m);
  for (const v of ['project=P_7', 'item=I1', 'field=F_status', 'option=o3']) assert.ok(m.args.includes(v), v);
});

test('label mode puts an open issue with an open linked PR in PR open, and has no sprints', async () => {
  const { gh, calls } = fakeGh([
    [
      (j) => j.includes('issues(labels'),
      () => ({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                issueNode(1),
                issueNode(2, { prs: [{ number: 41 }] }),
                issueNode(3, { prs: [{ number: 40, state: 'MERGED' }] }),
              ],
            },
          },
        },
      }),
    ],
  ]);
  const ad = new GitHubIssuesAdapter(labelCfg, gh);
  const { columns, items } = await ad.board();
  assert.deepEqual(
    columns.map((c) => [c.name, c.stage]),
    [
      ['Open', 'not-started'],
      ['PR open', 'in-review'],
      ['Closed', 'done'],
    ],
  );
  assert.deepEqual(
    items.map((i) => [i.key, i.column]),
    [
      ['#1', 'Open'],
      ['#2', 'PR open'],
      ['#3', 'Open'],
    ],
  );
  assert.ok(calls[0].args.includes('label=checkout'));
  assert.deepEqual(await ad.sprints(), []);
});

test('label mode move to testing throws TrackerMoveError and runs no gh write', async () => {
  const { gh, calls } = fakeGh([]);
  await assert.rejects(
    new GitHubIssuesAdapter(labelCfg, gh).move('1', 'testing'),
    (e: Error) =>
      e instanceof TrackerMoveError &&
      e.message === 'A label board has no "testing" column; its PR open column follows linked PRs.',
  );
  assert.equal(calls.length, 0);
});

test('label mode move to done closes the issue', async () => {
  const { gh, calls } = fakeGh([[(j) => j.startsWith('issue close'), () => '']]);
  const col = await new GitHubIssuesAdapter(labelCfg, gh).move('3', 'done');
  assert.equal(col.name, 'Closed');
  assert.deepEqual(calls[0].args, ['issue', 'close', '3', '-R', 'contoso/storefront']);
});

test('a gh auth failure throws TrackerAuthError for github.com', async () => {
  const gh: GhRunner = async () => {
    throw new Error('gh: To get started with GitHub CLI, please run:  gh auth login');
  };
  await assert.rejects(new GitHubIssuesAdapter(projectCfg, gh).board(), (e: Error) => {
    assert.ok(e instanceof TrackerAuthError);
    assert.deepEqual(e.ref, { kind: 'github', site: 'github.com' });
    return true;
  });
  assert.ok(isGhAuthError('gh: HTTP 401: Bad credentials'));
  assert.ok(!isGhAuthError('gh: HTTP 404: Not Found'));
});

test('comment sends the text on stdin', async () => {
  const { gh, calls } = fakeGh([[(j) => j.startsWith('issue comment'), () => '']]);
  await new GitHubIssuesAdapter(labelCfg, gh).comment('3', 'PR #41 is up');
  assert.deepEqual(calls[0].args, ['issue', 'comment', '3', '-R', 'contoso/storefront', '--body-file', '-']);
  assert.equal(calls[0].input, 'PR #41 is up');
});

test('story reads the issue with gh issue view', async () => {
  const { gh } = fakeGh([
    [
      (j) => j.startsWith('issue view'),
      () => ({
        number: 3,
        title: 'Saved cards',
        body: 'Show every saved card.\n\n- [ ] One',
        state: 'OPEN',
        url: 'https://github.com/contoso/storefront/issues/3',
        assignees: [{ login: 'patdoe' }],
        comments: [{ author: { login: 'sam' }, createdAt: '2026-10-02T10:00:00Z', body: 'Looks good' }],
      }),
    ],
  ]);
  const d = await new GitHubIssuesAdapter(labelCfg, gh).story('3');
  assert.equal(d.item.key, '#3');
  assert.equal(d.description, 'Show every saved card.\n\n- [ ] One');
  assert.equal(d.acceptance, null);
  assert.deepEqual(d.comments, [{ author: 'sam', at: Date.parse('2026-10-02T10:00:00Z'), text: 'Looks good' }]);
});

test('an id copied with its # from list_board works everywhere', async () => {
  const { gh, calls } = fakeGh([
    [
      (j) => j.startsWith('issue view'),
      () => ({ number: 45, title: 't', body: '', state: 'OPEN', url: 'u', comments: [] }),
    ],
    [(j) => j.startsWith('issue close'), () => ''],
    [(j) => j.startsWith('issue comment'), () => ''],
  ]);
  const ad = new GitHubIssuesAdapter(labelCfg, gh);
  await ad.story('#45');
  await ad.move('#45', 'done');
  await ad.comment('#45', 'hi');
  assert.deepEqual(
    calls.map((c) => c.args.slice(0, 3)),
    [
      ['issue', 'view', '45'],
      ['issue', 'close', '45'],
      ['issue', 'comment', '45'],
    ],
  );
});
