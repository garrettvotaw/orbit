import type {
  BoardColumn,
  GitHubTrackerConfig,
  OrbitStage,
  PrRef,
  SprintWindow,
  TrackerItem,
  TrackerRef,
} from '../../shared/types.ts';
import type { GhRunner } from '../github.ts';
import { STAGE_COLORS, columnFor, stageFromName, withStages } from './stages.ts';
import {
  TrackerAuthError,
  TrackerMoveError,
  TrackerUnsupportedError,
  markerTag,
  noColumnError,
  noSuchColumnError,
  withMarker,
  type CommentOptions,
  type CommentResult,
  type LinkKind,
  type MoveOptions,
  type StoryDetail,
  type StoryFile,
  type Tracker,
} from './tracker.ts';

// One line each, like TEAM_PRS_QUERY, so they pass through Windows argument quoting untouched.
const ISSUE_FIELDS = [
  'number title url state updatedAt',
  'assignees(first: 1) { nodes { login } }',
  'repository { nameWithOwner }',
  'closedByPullRequestsReferences(first: 10) { nodes { number state repository { nameWithOwner } } }',
].join(' ');

export const PROJECT_ITEMS_QUERY = [
  'query($owner: String!, $number: Int!, $after: String) {',
  'repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id',
  'fields(first: 50) { nodes {',
  '... on ProjectV2SingleSelectField { id name options { id name } }',
  '... on ProjectV2IterationField { id name configuration {',
  'iterations { title startDate duration } completedIterations { title startDate duration } } } } }',
  'items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id',
  `content { __typename ... on Issue { ${ISSUE_FIELDS} } }`,
  'fieldValues(first: 20) { nodes {',
  '... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { name } } }',
  '... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }',
  '} } } } } } } }',
].join(' ');

const labelQuery = (filter: string) =>
  [
    'query($owner: String!, $name: String!, $label: String!, $since: DateTime, $after: String) {',
    'repository(owner: $owner, name: $name) {',
    `issues(labels: [$label], ${filter}first: 100, after: $after, filterBy: { since: $since }) {`,
    `pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} } } } }`,
  ].join(' ');
export const LABEL_OPEN_QUERY = labelQuery('states: OPEN, ');
export const LABEL_ANY_QUERY = labelQuery('');

export const ISSUE_PARENT_QUERY = [
  'query($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) { issue(number: $number) {',
  'parent { number title url state body } } } }',
].join(' ');

export const SET_STATUS_MUTATION = [
  'mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {',
  'updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,',
  'value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }',
].join(' ');

export function isGhAuthError(message: string): boolean {
  return /gh auth login|HTTP 401|not logged in|authentication required/i.test(message);
}

const NO_STATUS = 'No Status';
const LABEL_COLUMNS: BoardColumn[] = [
  { name: 'Open', stage: 'not-started', color: STAGE_COLORS['not-started'] },
  { name: 'PR open', stage: 'in-review', color: STAGE_COLORS['in-review'] },
  { name: 'Closed', stage: 'done', color: STAGE_COLORS.done },
];
const MAX_PAGES = 50;
const LINK_COMMENT: Record<LinkKind, string> = { duplicate: 'Duplicate of', related: 'Related to', blocks: 'Blocks' };

interface RawIssue {
  __typename?: string;
  number: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt?: string;
  assignees?: { nodes?: Array<{ login?: string }> };
  repository?: { nameWithOwner?: string };
  closedByPullRequestsReferences?: {
    nodes?: Array<{ number: number; state?: string; repository?: { nameWithOwner?: string } }>;
  };
}
interface RawField {
  id: string;
  name: string;
  options?: Array<{ id: string; name: string }>;
  configuration?: { iterations?: RawIteration[]; completedIterations?: RawIteration[] };
}
interface RawIteration {
  title: string;
  startDate: string;
  duration: number;
}
interface RawProjectItem {
  id: string;
  content?: RawIssue | null;
  fieldValues?: { nodes?: Array<{ name?: string; title?: string; field?: { name?: string } }> };
}
interface Page<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: T[];
}

const prsOf = (i: RawIssue): PrRef[] =>
  (i.closedByPullRequestsReferences?.nodes ?? []).map((p) => ({
    repo: p.repository?.nameWithOwner ?? null,
    number: p.number,
  }));

/** Local midnight on a `YYYY-MM-DD` day, `days` later. */
function localDay(iso: string, days = 0): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d + days).getTime();
}

/** An issue number however an agent wrote it: `45`, or `#45` copied from list_board. */
const issueNumber = (key: string) => key.trim().replace(/^#/, '');

/** A stage for the n-th Status option when neither the config nor the name says: first, middle, last. */
function positional(index: number, count: number): OrbitStage {
  if (index === 0) return 'not-started';
  return index === count - 1 ? 'done' : 'building';
}

/** GitHub Issues behind the tracker interface: a Project (v2) board, or a label's open / PR open / closed. */
export class GitHubIssuesAdapter implements Tracker {
  readonly ref: TrackerRef = { kind: 'github', site: 'github.com' };
  readonly #cfg: GitHubTrackerConfig;
  readonly #gh: GhRunner;
  #columns: BoardColumn[] = [];
  #projectId = '';
  #statusField: RawField | null = null;
  #itemIds = new Map<string, string>();
  #items = new Map<string, TrackerItem>();
  /** updatedAt per issue from the last project read, for shipped(since). */
  #updated = new Map<string, string>();
  #me: string | null = null;

  constructor(cfg: GitHubTrackerConfig, gh: GhRunner) {
    this.#cfg = cfg;
    this.#gh = gh;
  }

  async board(): Promise<{ columns: BoardColumn[]; items: TrackerItem[] }> {
    const items = this.#cfg.project === undefined ? await this.#labelItems(true) : await this.#projectItems(true);
    for (const i of items) this.#items.set(i.id, i);
    return { columns: this.#columns, items };
  }

  async shipped(since: string): Promise<TrackerItem[]> {
    if (this.#cfg.project === undefined) return this.#labelItems(false, since);
    return (await this.#projectItems(false)).filter((i) => (this.#updated.get(i.id) ?? '') >= since);
  }

  async sprints(): Promise<SprintWindow[]> {
    if (this.#cfg.project === undefined) return [];
    const { fields } = await this.#projectPage(null);
    const iteration =
      fields.find((f) => f.configuration && f.name === this.#cfg.iterationField) ?? fields.find((f) => f.configuration);
    const all = [
      ...(iteration?.configuration?.completedIterations ?? []),
      ...(iteration?.configuration?.iterations ?? []),
    ];
    return all
      .map((it) => ({
        name: it.title,
        path: it.title,
        start: localDay(it.startDate),
        finish: localDay(it.startDate, it.duration),
      }))
      .sort((a, b) => a.start - b.start);
  }

  async story(key: string): Promise<StoryDetail> {
    const id = issueNumber(key);
    const json = await this.#run([
      'issue',
      'view',
      id,
      '-R',
      this.#cfg.repo,
      '--json',
      'number,title,body,state,url,comments,assignees',
    ]);
    const raw = JSON.parse(json) as {
      number: number;
      title?: string;
      body?: string;
      state?: string;
      url?: string;
      assignees?: Array<{ login?: string }>;
      comments?: Array<{ author?: { login?: string }; createdAt?: string; body?: string }>;
    };
    const item = {
      ...this.#known({ number: raw.number, title: raw.title, url: raw.url, state: raw.state }),
      assignedTo: raw.assignees?.[0]?.login ?? null,
    };
    const parent = await this.#parent(id);
    return {
      item,
      description: raw.body ?? '',
      acceptance: null,
      comments: (raw.comments ?? []).map((c) => ({
        author: c.author?.login ?? '',
        at: c.createdAt ? Date.parse(c.createdAt) : 0,
        text: c.body ?? '',
      })),
      children: [],
      links: [],
      reproSteps: null,
      parent: parent && { item: this.#known(parent), description: parent.body ?? '', acceptance: null },
      // GitHub has no typed links and keeps files inline in the text.
      related: [],
      attachments: [],
    };
  }

  /** An issue as the last board read saw it, else Open or Closed by its state. */
  #known(raw: RawIssue): TrackerItem {
    const seen = this.#items.get(String(raw.number));
    if (seen) return seen;
    const closed = raw.state === 'CLOSED';
    return { ...this.#toItem(raw, closed ? 'Closed' : 'Open', null), stage: closed ? 'done' : 'not-started' };
  }

  /** The issue's parent, when it is a sub-issue. */
  async #parent(id: string): Promise<(RawIssue & { body?: string }) | null> {
    const [owner, name] = this.#cfg.repo.split('/');
    const res = (await this.#graphql(ISSUE_PARENT_QUERY, { owner, name }, { number: Number(id) })) as {
      data?: { repository?: { issue?: { parent?: (RawIssue & { body?: string }) | null } } };
    };
    return res.data?.repository?.issue?.parent ?? null;
  }

  async move(key: string, stage: OrbitStage, opts: MoveOptions = {}): Promise<BoardColumn> {
    const id = issueNumber(key);
    const column =
      this.#cfg.project === undefined
        ? await this.#moveLabel(id, stage, opts.column)
        : await this.#moveProject(id, stage, opts.column);
    if (opts.assignToMe) await this.#run(['issue', 'edit', id, '-R', this.#cfg.repo, '--add-assignee', '@me']);
    if (opts.note) await this.comment(id, opts.note);
    return column;
  }

  async comment(key: string, text: string, opts: CommentOptions = {}): Promise<CommentResult> {
    const id = issueNumber(key);
    const body = withMarker(text, opts.marker);
    const found = opts.marker ? await this.#findComment(id, markerTag(opts.marker)) : null;
    if (found !== null) {
      const path = `repos/${this.#cfg.repo}/issues/comments/${found}`;
      await this.#run(['api', '-X', 'PATCH', path, '--input', '-'], JSON.stringify({ body }));
      return 'updated';
    }
    await this.#run(['issue', 'comment', id, '-R', this.#cfg.repo, '--body-file', '-'], body);
    return 'posted';
  }

  /**
   * GitHub's link is a comment naming the other issue, which it shows as a cross-reference; a duplicate
   * gets the "Duplicate of" comment GitHub recognizes and is closed as one.
   */
  async link(key: string, otherKey: string, kind: LinkKind): Promise<void> {
    const id = issueNumber(key);
    const other = `#${issueNumber(otherKey)}`;
    await this.comment(id, `${LINK_COMMENT[kind]} ${other}`);
    if (kind !== 'duplicate') return;
    const path = `repos/${this.#cfg.repo}/issues/${id}`;
    await this.#run(['api', '-X', 'PATCH', path, '-f', 'state=closed', '-f', 'state_reason=duplicate']);
  }

  /**
   * The id of an issue comment the signed-in user wrote whose markdown carries this tag, or null.
   * A quote reply copies the tag, so the author is what tells Orbit's comment from a teammate's.
   */
  async #findComment(id: string, tag: string): Promise<number | null> {
    const me = await this.#login();
    const path = `repos/${this.#cfg.repo}/issues/${id}/comments?per_page=100`;
    const out = await this.#run(['api', '--paginate', path, '--jq', '.[] | {id, body, login: .user.login}']);
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as { id: number; body?: string; login?: string };
      if (c.body?.includes(tag) && c.login === me) return c.id;
    }
    return null;
  }

  /** Who gh is signed in as, asked once. */
  async #login(): Promise<string> {
    this.#me ??= (await this.#run(['api', 'user', '--jq', '.login'])).trim();
    return this.#me;
  }

  async attach(): Promise<{ name: string; url: string }> {
    throw new TrackerUnsupportedError(
      "GitHub's API has no issue attachments; commit the file or link it in a comment.",
    );
  }

  async attachment(): Promise<StoryFile> {
    throw new TrackerUnsupportedError(
      'GitHub keeps files inline in the issue text; read the links in its description.',
    );
  }

  async #moveLabel(id: string, wanted: OrbitStage, columnName?: string): Promise<BoardColumn> {
    const named = columnName ? LABEL_COLUMNS.find((c) => c.name === columnName) : undefined;
    if (columnName && named?.name !== 'Open' && named?.name !== 'Closed')
      throw noSuchColumnError(
        columnName,
        LABEL_COLUMNS.filter((c) => c.name !== 'PR open'),
      );
    const stage = named?.stage ?? wanted;
    if (stage === 'done') await this.#run(['issue', 'close', id, '-R', this.#cfg.repo]);
    else if (stage === 'not-started') await this.#run(['issue', 'reopen', id, '-R', this.#cfg.repo]);
    else throw new TrackerMoveError(`A label board has no "${stage}" column; its PR open column follows linked PRs.`);
    return LABEL_COLUMNS.find((c) => c.stage === stage)!;
  }

  async #moveProject(id: string, stage: OrbitStage, columnName?: string): Promise<BoardColumn> {
    if (!this.#columns.length || !this.#itemIds.has(id)) await this.board();
    const targets = this.#columns.filter((c) => c.name !== NO_STATUS);
    const column = columnName ? (targets.find((c) => c.name === columnName) ?? null) : columnFor(stage, targets);
    if (!column) throw columnName ? noSuchColumnError(columnName, targets) : noColumnError(stage, targets);
    const item = this.#itemIds.get(id);
    if (!item) throw new TrackerMoveError(`#${id} is not on project ${this.#cfg.project}.`);
    const option = this.#statusField?.options?.find((o) => o.name === column.name);
    await this.#graphql(SET_STATUS_MUTATION, {
      project: this.#projectId,
      item,
      field: this.#statusField?.id ?? '',
      option: option?.id ?? '',
    });
    return column;
  }

  async #projectItems(openOnly: boolean): Promise<TrackerItem[]> {
    const out: TrackerItem[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { fields, items, next } = await this.#projectPage(after);
      if (page === 0) this.#setProjectColumns(fields);
      for (const it of items) {
        const issue = it.content;
        if (
          issue?.__typename !== 'Issue' ||
          issue.repository?.nameWithOwner?.toLowerCase() !== this.#cfg.repo.toLowerCase()
        )
          continue;
        if (openOnly && issue.state !== 'OPEN') continue;
        const values = it.fieldValues?.nodes ?? [];
        const status = values.find((v) => v.field?.name === 'Status' && v.name)?.name ?? NO_STATUS;
        const sprint = values.find(
          (v) => v.title && (!this.#cfg.iterationField || v.field?.name === this.#cfg.iterationField),
        );
        this.#itemIds.set(String(issue.number), it.id);
        this.#updated.set(String(issue.number), (issue.updatedAt ?? '').slice(0, 10));
        out.push(this.#toItem(issue, status, sprint?.title ?? null));
      }
      if (!next) break;
      after = next;
    }
    return withStages(out, this.#columns, this.#cfg.stages);
  }

  async #projectPage(
    after: string | null,
  ): Promise<{ fields: RawField[]; items: RawProjectItem[]; next: string | null }> {
    const [owner] = this.#cfg.repo.split('/');
    const res = (await this.#graphql(PROJECT_ITEMS_QUERY, { owner, after }, { number: this.#cfg.project ?? 0 })) as {
      data?: {
        repositoryOwner?: { projectV2?: { id: string; fields?: { nodes?: RawField[] }; items?: Page<RawProjectItem> } };
      };
    };
    const project = res.data?.repositoryOwner?.projectV2;
    if (!project) throw new Error(`GitHub project ${this.#cfg.project} not found for ${owner}`);
    this.#projectId = project.id;
    const page = project.items?.pageInfo;
    return {
      fields: (project.fields?.nodes ?? []).filter((f) => f && f.id),
      items: project.items?.nodes ?? [],
      next: page?.hasNextPage && page.endCursor ? page.endCursor : null,
    };
  }

  #setProjectColumns(fields: RawField[]): void {
    this.#statusField = fields.find((f) => f.name === 'Status' && f.options) ?? null;
    const options = this.#statusField?.options ?? [];
    const stageFor = (name: string, i: number) =>
      this.#cfg.stages?.[name] ?? stageFromName(name) ?? positional(i, options.length);
    this.#columns = [
      { name: NO_STATUS, stage: 'not-started', color: STAGE_COLORS['not-started'] },
      ...options.map((o, i) => {
        const stage = stageFor(o.name, i);
        return { name: o.name, stage, color: STAGE_COLORS[stage] };
      }),
    ];
  }

  async #labelItems(openOnly: boolean, since?: string): Promise<TrackerItem[]> {
    this.#columns = LABEL_COLUMNS;
    const [owner, name] = this.#cfg.repo.split('/');
    const out: TrackerItem[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const vars = { owner, name, label: this.#cfg.label ?? '', after, since: since ? `${since}T00:00:00Z` : null };
      const res = (await this.#graphql(openOnly ? LABEL_OPEN_QUERY : LABEL_ANY_QUERY, vars)) as {
        data?: { repository?: { issues?: Page<RawIssue> } };
      };
      const issues = res.data?.repository?.issues;
      for (const i of issues?.nodes ?? []) {
        const openPr = (i.closedByPullRequestsReferences?.nodes ?? []).some((p) => p.state === 'OPEN');
        const column = i.state === 'CLOSED' ? 'Closed' : openPr ? 'PR open' : 'Open';
        out.push(this.#toItem(i, column, null));
      }
      const next = issues?.pageInfo;
      if (!next?.hasNextPage || !next.endCursor) break;
      after = next.endCursor;
    }
    return withStages(out, this.#columns, this.#cfg.stages);
  }

  #toItem(i: RawIssue, column: string | null, sprint: string | null): TrackerItem {
    return {
      id: String(i.number),
      key: `#${i.number}`,
      title: i.title ?? '',
      type: 'Issue',
      column: column ?? 'Open',
      stage: 'not-started',
      assignedTo: i.assignees?.nodes?.[0]?.login ?? null,
      parentId: null,
      prs: prsOf(i),
      url: i.url ?? '',
      sprint,
    };
  }

  /** `gh api graphql` with string variables as -f and numbers as -F; null variables are left out. */
  #graphql(query: string, strings: Record<string, string | null>, numbers: Record<string, number> = {}) {
    const args = ['api', 'graphql'];
    for (const [k, v] of Object.entries(strings)) if (v !== null) args.push('-f', `${k}=${v}`);
    for (const [k, v] of Object.entries(numbers)) args.push('-F', `${k}=${v}`);
    return this.#run([...args, '-f', `query=${query}`]).then((out) => JSON.parse(out) as unknown);
  }

  async #run(args: string[], input?: string): Promise<string> {
    try {
      return await this.#gh(args, undefined, input);
    } catch (e) {
      const message = (e as Error).message;
      if (isGhAuthError(message)) throw new TrackerAuthError(this.ref, message);
      throw e;
    }
  }
}
