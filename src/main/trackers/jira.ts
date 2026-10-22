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
  MAX_ATTACHMENT_READ,
  TrackerAuthError,
  TrackerMoveError,
  htmlToText,
  mimeOf,
  noColumnError,
  readCapped,
  noSuchAttachment,
  noSuchColumnError,
  type CommentOptions,
  type CommentResult,
  type LinkKind,
  type MoveOptions,
  type RelationKind,
  type StoryComment,
  type StoryDetail,
  type StoryFile,
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
const MARKER_PROPERTY = 'orbit-marker';
/** Jira's stock link type for each kind; link() puts the first issue on the side that reads "duplicates" or "blocks". */
const LINK_TYPE: Record<LinkKind, string> = { duplicate: 'Duplicate', related: 'Relates', blocks: 'Blocks' };

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

  put(path: string, body: unknown): Promise<unknown> {
    return this.#send('PUT', path, body);
  }

  /** Posts a file as the multipart field `file`, the way Jira's attachment API takes it. */
  upload(path: string, file: { name: string; data: Uint8Array }): Promise<unknown> {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(file.data)]), file.name);
    return this.#send('POST', path, form);
  }

  /** A file by its content URL (or that URL's path on this site), signed in. */
  async download(url: string): Promise<{ data: Uint8Array; size: number | null; type: string | null }> {
    const path = url.startsWith(`https://${this.#site}`) ? url.slice(`https://${this.#site}`.length) : url;
    const res = await this.#request('GET', path, undefined, '*/*');
    return { ...(await readCapped(res, MAX_ATTACHMENT_READ)), type: res.headers?.get('content-type') ?? null };
  }

  /** The response's JSON, or null when Jira sends no body (a 204, or the 201 an issue link gets). */
  async #send(method: string, path: string, body?: unknown): Promise<unknown> {
    const text = await (await this.#request(method, path, body)).text();
    return text ? JSON.parse(text) : null;
  }

  /** The response once sign-in and status are checked: a 401 or 403 is an auth error, any other failure throws. */
  async #request(method: string, path: string, body?: unknown, accept = 'application/json') {
    const creds = this.#creds();
    if (!creds) throw new TrackerAuthError(this.ref, `No Jira sign-in for ${this.#site}`);
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`,
      Accept: accept,
    };
    // A form sets its own multipart Content-Type; Jira refuses one without the no-check token.
    const form = body instanceof FormData;
    if (form) headers['X-Atlassian-Token'] = 'no-check';
    else if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.#fetch(`https://${this.#site}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new TrackerAuthError(this.ref, `Jira ${res.status}: sign-in rejected for ${this.#site}`);
    }
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
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
  #accountId: string | null = null;

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
    const it = await this.#issue(id);
    const raw = it.fields.comment?.comments ?? [];
    const rendered = it.renderedFields?.comment?.comments ?? [];
    const comments: StoryComment[] = raw.map((c: any, i: number) => ({
      author: c.author?.displayName ?? '',
      at: c.created ? Date.parse(c.created) : 0,
      text: htmlToText(rendered[i]?.body ?? ''),
    }));
    const parentKey: string | undefined = it.fields.parent?.key;
    const parent = parentKey ? await this.#issue(parentKey) : null;
    return {
      item: this.#toItem(it),
      description: htmlToText(it.renderedFields?.description ?? ''),
      acceptance: null,
      comments,
      children: (it.fields.subtasks ?? []).map((s: JiraIssue) => this.#toItem(s)),
      links: [],
      reproSteps: null,
      parent: parent && {
        item: this.#toItem(parent),
        description: htmlToText(parent.renderedFields?.description ?? ''),
        acceptance: null,
      },
      related: (it.fields.issuelinks ?? []).flatMap((l: any) => this.#relation(l)),
      attachments: (it.fields.attachment ?? []).map((a: any) => ({ name: String(a.filename), url: String(a.content) })),
    };
  }

  /** One issue with everything get_story shows; renderedFields only carries the fields asked for. */
  #issue(key: string): Promise<JiraIssue> {
    const fields = 'summary,status,issuetype,assignee,parent,subtasks,issuelinks,comment,description,attachment';
    return this.#client.get(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}&expand=renderedFields`,
    ) as Promise<JiraIssue>;
  }

  /**
   * An issue link read from this issue's side: Blocks outward is `blocks`, Duplicate outward
   * `duplicate-of`. Sites rename link types, so the type's wording counts as much as its name.
   */
  #relation(l: any): Array<{ kind: RelationKind; item: TrackerItem }> {
    const other: JiraIssue | undefined = l.outwardIssue ?? l.inwardIssue;
    if (!other) return [];
    const outward = Boolean(l.outwardIssue);
    const says = `${l.type?.name ?? ''} ${l.type?.outward ?? ''} ${l.type?.inward ?? ''}`;
    let kind: RelationKind = 'related';
    if (/block/i.test(says)) kind = outward ? 'blocks' : 'blocked-by';
    else if (/duplicat/i.test(says)) kind = outward ? 'duplicate-of' : 'duplicate';
    return [{ kind, item: this.#toItem(other) }];
  }

  async move(id: string, stage: OrbitStage, opts: MoveOptions = {}): Promise<BoardColumn> {
    if (!this.#columns.length) await this.#loadColumns();
    const targets = opts.column
      ? this.#columns.filter((c) => c.name === opts.column)
      : this.#columns.filter((c) => c.stage === stage);
    if (!targets.length)
      throw opts.column ? noSuchColumnError(opts.column, this.#columns) : noColumnError(stage, this.#columns);
    const path = `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`;
    const res = (await this.#client.get(path)) as { transitions?: Array<{ id: string; to?: { id?: string } }> };
    for (const column of targets) {
      const lands = new Set(this.#statusIds.get(column.name) ?? []);
      const t = (res.transitions ?? []).find((tr) => tr.to?.id && lands.has(tr.to.id));
      if (!t) continue;
      await this.#client.post(path, { transition: { id: t.id } });
      if (opts.assignToMe) await this.#assignToMe(id);
      if (opts.note) await this.comment(id, opts.note);
      return column;
    }
    const names = targets.map((c) => c.name).join(', ');
    throw new TrackerMoveError(`No transition from where ${id} is to a "${opts.column ?? stage}" column (${names}).`);
  }

  async #assignToMe(id: string): Promise<void> {
    if (!this.#accountId) {
      const me = (await this.#client.get('/rest/api/3/myself')) as { accountId?: string };
      if (!me.accountId) throw new Error('Jira did not say who is signed in');
      this.#accountId = me.accountId;
    }
    await this.#client.put(`/rest/api/3/issue/${encodeURIComponent(id)}/assignee`, { accountId: this.#accountId });
  }

  /** A marker rides on the comment as an `orbit-marker` property, so it never shows in the text. */
  async comment(id: string, text: string, opts: CommentOptions = {}): Promise<CommentResult> {
    const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
    const path = `/rest/api/3/issue/${encodeURIComponent(id)}/comment`;
    const { marker } = opts;
    if (!marker) {
      await this.#client.post(path, { body });
      return 'posted';
    }
    const res = (await this.#client.get(`${path}?expand=properties`)) as {
      comments?: Array<{ id: string; properties?: Array<{ key: string; value: unknown }> }>;
    };
    const found = (res.comments ?? []).find((c) =>
      (c.properties ?? []).some((p) => p.key === MARKER_PROPERTY && p.value === marker),
    );
    if (found) {
      await this.#client.put(`${path}/${found.id}`, { body });
      return 'updated';
    }
    await this.#client.post(path, { body, properties: [{ key: MARKER_PROPERTY, value: marker }] });
    return 'posted';
  }

  /** In the POST, inwardIssue is the issue linked from: it reads with the type's outward wording ("blocks"). */
  async link(id: string, otherId: string, kind: LinkKind): Promise<void> {
    await this.#client.post('/rest/api/3/issueLink', {
      type: { name: LINK_TYPE[kind] },
      inwardIssue: { key: id },
      outwardIssue: { key: otherId },
    });
  }

  async attach(id: string, file: { name: string; data: Uint8Array }): Promise<{ name: string; url: string }> {
    const res = (await this.#client.upload(`/rest/api/3/issue/${encodeURIComponent(id)}/attachments`, file)) as Array<{
      filename?: string;
      content?: string;
    }>;
    const saved = res?.[0];
    if (!saved?.content) throw new Error(`Jira did not say where it put ${file.name}`);
    return { name: saved.filename ?? file.name, url: saved.content };
  }

  async attachment(id: string, name: string): Promise<StoryFile> {
    const it = (await this.#client.get(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=attachment`)) as JiraIssue;
    const files: Array<{ filename: string; content: string }> = it.fields.attachment ?? [];
    const found = files.find((f) => f.filename === name);
    if (!found)
      throw noSuchAttachment(
        id,
        name,
        files.map((f) => f.filename),
      );
    const { data, size, type } = await this.#client.download(found.content);
    return { name, mimeType: mimeOf(name, type), data, size };
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
