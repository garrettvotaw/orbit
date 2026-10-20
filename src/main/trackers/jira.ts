import type {
  BoardColumn,
  JiraTrackerConfig,
  OrbitStage,
  SprintWindow,
  TrackerItem,
  TrackerRef,
} from '../../shared/types.ts';
import type { FetchLike } from './ado.ts';
import { STAGE_COLORS, stageOf, withStages, type StateCategory } from './stages.ts';
import {
  TrackerAuthError,
  TrackerMoveError,
  htmlToText,
  noColumnError,
  type StoryComment,
  type StoryDetail,
  type Tracker,
} from './tracker.ts';

export interface JiraCreds {
  email: string;
  token: string;
}

/** The PM's stories: still open, or changed since a day, under its epic or its JQL filter. */
export function jiraJql(cfg: JiraTrackerConfig, mode: { open: true } | { since: string }): string {
  const scope = cfg.epic ? `parent = ${cfg.epic}` : `(${cfg.jql})`;
  const when = 'open' in mode ? 'statusCategory != Done' : `updated >= "${mode.since}"`;
  return `project = ${cfg.projectKey} AND ${scope} AND ${when} ORDER BY key`;
}

const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const MAX_PAGES = 50;
const CATEGORY: Record<string, StateCategory> = { new: 'proposed', indeterminate: 'in-progress', done: 'completed' };

/** One Jira Cloud site, signed in with an email and an API token. */
export class JiraClient {
  readonly #site: string;
  readonly #creds: () => JiraCreds | null;
  readonly #fetch: FetchLike;
  readonly ref: TrackerRef;

  constructor(site: string, creds: () => JiraCreds | null, fetchFn: FetchLike = fetch as unknown as FetchLike) {
    this.#site = site;
    this.#creds = creds;
    this.#fetch = fetchFn;
    this.ref = { kind: 'jira', site };
  }

  browseUrl(key: string): string {
    return `https://${this.#site}/browse/${key}`;
  }

  get(path: string): Promise<unknown> {
    return this.#send('GET', path);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.#send('POST', path, body);
  }

  async #send(method: string, path: string, body?: unknown): Promise<unknown> {
    const creds = this.#creds();
    if (!creds) throw new TrackerAuthError(this.ref, `No Jira sign-in for ${this.#site}`);
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.#fetch(`https://${this.#site}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new TrackerAuthError(this.ref, `Jira ${res.status}: sign-in rejected for ${this.#site}`);
    }
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }
}

interface JiraIssue {
  key: string;
  fields: Record<string, any>;
  renderedFields?: Record<string, any>;
}

/** A Jira board behind the tracker interface: its columns, its epic's or filter's issues, its sprints. */
export class JiraAdapter implements Tracker {
  readonly ref: TrackerRef;
  readonly #cfg: JiraTrackerConfig;
  readonly #client: JiraClient;
  #columns: BoardColumn[] = [];
  /** Each column's status ids, in board order: what a transition has to land on. */
  #statusIds = new Map<string, string[]>();
  #sprintField: string | null | undefined;

  constructor(cfg: JiraTrackerConfig, client: JiraClient) {
    this.#cfg = cfg;
    this.#client = client;
    this.ref = client.ref;
  }

  async board(): Promise<{ columns: BoardColumn[]; items: TrackerItem[] }> {
    await this.#loadColumns();
    const items = await this.#search(jiraJql(this.#cfg, { open: true }));
    return { columns: this.#columns, items };
  }

  async shipped(since: string): Promise<TrackerItem[]> {
    if (!this.#columns.length) await this.#loadColumns();
    return this.#search(jiraJql(this.#cfg, { since }));
  }

  async sprints(): Promise<SprintWindow[]> {
    const out: SprintWindow[] = [];
    try {
      for (let startAt = 0, page = 0; page < MAX_PAGES; page++) {
        const res = (await this.#client.get(
          `/rest/agile/1.0/board/${this.#cfg.board}/sprint?state=active,closed&startAt=${startAt}`,
        )) as { values?: Array<{ name?: string; startDate?: string; endDate?: string }>; isLast?: boolean };
        const values = res.values ?? [];
        for (const s of values) {
          if (s.name && s.startDate && s.endDate)
            out.push({ name: s.name, path: s.name, start: Date.parse(s.startDate), finish: Date.parse(s.endDate) });
        }
        if (res.isLast !== false || !values.length) break;
        startAt += values.length;
      }
    } catch (e) {
      // A kanban board has no sprints and says so with a 400.
      if (/^Jira 400\b/.test((e as Error).message)) return [];
      throw e;
    }
    return out;
  }

  async story(id: string): Promise<StoryDetail> {
    if (!this.#columns.length) await this.#loadColumns();
    // renderedFields only carries the fields asked for, so description has to be named.
    const fields = 'summary,status,issuetype,assignee,parent,subtasks,issuelinks,comment,description';
    const it = (await this.#client.get(
      `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${fields}&expand=renderedFields`,
    )) as JiraIssue;
    const raw = it.fields.comment?.comments ?? [];
    const rendered = it.renderedFields?.comment?.comments ?? [];
    const comments: StoryComment[] = raw.map((c: any, i: number) => ({
      author: c.author?.displayName ?? '',
      at: c.created ? Date.parse(c.created) : 0,
      text: htmlToText(rendered[i]?.body ?? ''),
    }));
    const links = (it.fields.issuelinks ?? []).flatMap((l: any) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      const verb = l.outwardIssue ? l.type?.outward : l.type?.inward;
      return other ? [{ title: `${verb ?? 'relates to'} ${other.key}`, url: this.#client.browseUrl(other.key) }] : [];
    });
    return {
      item: this.#toItem(it),
      description: htmlToText(it.renderedFields?.description ?? ''),
      acceptance: null,
      comments,
      children: (it.fields.subtasks ?? []).map((s: JiraIssue) => this.#toItem(s)),
      links,
    };
  }

  async move(id: string, stage: OrbitStage, note?: string): Promise<BoardColumn> {
    if (!this.#columns.length) await this.#loadColumns();
    const targets = this.#columns.filter((c) => c.stage === stage);
    if (!targets.length) throw noColumnError(stage, this.#columns);
    const path = `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`;
    const res = (await this.#client.get(path)) as { transitions?: Array<{ id: string; to?: { id?: string } }> };
    for (const column of targets) {
      const lands = new Set(this.#statusIds.get(column.name) ?? []);
      const t = (res.transitions ?? []).find((tr) => tr.to?.id && lands.has(tr.to.id));
      if (!t) continue;
      await this.#client.post(path, { transition: { id: t.id } });
      if (note) await this.comment(id, note);
      return column;
    }
    const names = targets.map((c) => c.name).join(', ');
    throw new TrackerMoveError(`No transition from where ${id} is to a "${stage}" column (${names}).`);
  }

  async comment(id: string, text: string): Promise<void> {
    const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
    await this.#client.post(`/rest/api/3/issue/${encodeURIComponent(id)}/comment`, { body });
  }

  async #loadColumns(): Promise<void> {
    const [config, statuses] = (await Promise.all([
      this.#client.get(`/rest/agile/1.0/board/${this.#cfg.board}/configuration`),
      this.#client.get('/rest/api/3/status'),
    ])) as [
      { columnConfig?: { columns?: Array<{ name: string; statuses?: Array<{ id: string }> }> } },
      Array<{ id: string; statusCategory?: { key?: string } }>,
    ];
    const category = new Map(statuses.map((s) => [s.id, CATEGORY[s.statusCategory?.key ?? ''] ?? null]));
    const columns = config.columnConfig?.columns ?? [];
    this.#statusIds = new Map(columns.map((c) => [c.name, (c.statuses ?? []).map((s) => s.id)]));
    this.#columns = columns.map((c) => {
      const stage = stageOf(c.name, category.get(c.statuses?.[0]?.id ?? '') ?? null, this.#cfg.stages);
      return { name: c.name, stage, color: STAGE_COLORS[stage] };
    });
  }

  async #search(jql: string): Promise<TrackerItem[]> {
    const sprintField = await this.#findSprintField();
    const fields = ['summary', 'status', 'issuetype', 'assignee', 'parent', ...(sprintField ? [sprintField] : [])];
    const out: TrackerItem[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = (await this.#client.post('/rest/api/3/search/jql', {
        jql,
        fields,
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      })) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
      out.push(...(res.issues ?? []).map((i) => this.#toItem(i)));
      if (res.isLast !== false || !res.nextPageToken) break;
      nextPageToken = res.nextPageToken;
    }
    return withStages(out, this.#columns, this.#cfg.stages);
  }

  async #findSprintField(): Promise<string | null> {
    if (this.#sprintField === undefined) {
      const all = (await this.#client.get('/rest/api/3/field')) as Array<{ id: string; schema?: { custom?: string } }>;
      this.#sprintField = all.find((f) => f.schema?.custom === SPRINT_SCHEMA)?.id ?? null;
    }
    return this.#sprintField;
  }

  #toItem(it: JiraIssue): TrackerItem {
    const f = it.fields ?? {};
    const statusId = f.status?.id ?? '';
    const column = [...this.#statusIds].find(([, ids]) => ids.includes(statusId))?.[0] ?? String(f.status?.name ?? '');
    const sprints = this.#sprintField ? f[this.#sprintField] : null;
    return {
      id: it.key,
      key: it.key,
      title: String(f.summary ?? ''),
      type: String(f.issuetype?.name ?? ''),
      column,
      stage: stageOf(column, null, this.#cfg.stages),
      assignedTo: f.assignee?.displayName ?? null,
      parentId: f.parent?.key ?? null,
      prs: [],
      url: this.#client.browseUrl(it.key),
      sprint: Array.isArray(sprints) && sprints.length ? (sprints.at(-1)?.name ?? null) : null,
    };
  }
}
