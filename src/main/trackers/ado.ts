import { exec } from 'node:child_process';
import type {
  AdoTrackerConfig,
  BoardColumn,
  OrbitStage,
  SprintWindow,
  TrackerItem,
  TrackerRef,
} from '../../shared/types.ts';
import { adoColumns, columnFor, stageOf, withStages, type StateCategory, type TypeState } from './stages.ts';
import {
  TrackerAuthError,
  TrackerMoveError,
  htmlToText,
  noColumnError,
  type StoryComment,
  type StoryDetail,
  type Tracker,
} from './tracker.ts';

/** A work item as ADO's batch API gives it; the adapter turns it into a TrackerItem. */
export interface AdoItem {
  id: number;
  title: string;
  type: string;
  state: string;
  assignedTo: string | null;
  parentId: number | null;
  prNumbers: number[];
  url: string;
  /** The sprint the item is planned in, e.g. `Storefront\Sprint 41`; null when ADO has none. */
  iterationPath: string | null;
}

export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const TOKEN_SKEW_MS = 5 * 60_000;

export interface AdoToken {
  accessToken: string;
  expiresAt: number;
}

/** Parse the JSON `az account get-access-token` prints. */
export function parseAzToken(json: string): AdoToken {
  const o = JSON.parse(json) as { accessToken?: string; expires_on?: number | string; expiresOn?: string };
  if (!o.accessToken) throw new Error('az returned no accessToken');
  const epoch = typeof o.expires_on === 'number' ? o.expires_on : Number(o.expires_on);
  const expiresAt = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.parse(o.expiresOn ?? '');
  if (!Number.isFinite(expiresAt)) throw new Error('az token has no usable expiry');
  return { accessToken: o.accessToken, expiresAt };
}

export type TokenFetcher = () => Promise<string>;

export function azTokenFetcher(): TokenFetcher {
  return () =>
    new Promise((resolve, reject) => {
      // az is a .cmd on Windows, so it has to go through the shell; the command is a fixed string.
      exec(
        `az account get-access-token --resource ${ADO_RESOURCE} -o json`,
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 30_000 },
        (err, stdout, stderr) => {
          if (err)
            reject(
              new Error(
                `az: ${
                  String(stderr || err.message)
                    .trim()
                    .split('\n')[0]
                }`,
              ),
            );
          else resolve(stdout);
        },
      );
    });
}

/** Caches the ADO bearer token until five minutes before it expires. */
export class AdoTokenProvider {
  #token: AdoToken | null = null;
  #inflight: Promise<AdoToken> | null = null;
  readonly #fetch: TokenFetcher;
  readonly #now: () => number;

  constructor(fetch: TokenFetcher = azTokenFetcher(), now: () => number = Date.now) {
    this.#fetch = fetch;
    this.#now = now;
  }

  async get(): Promise<string> {
    if (this.#token && this.#token.expiresAt - TOKEN_SKEW_MS > this.#now()) return this.#token.accessToken;
    this.#inflight ??= this.#fetch()
      .then((json) => (this.#token = parseAzToken(json)))
      .finally(() => (this.#inflight = null));
    return (await this.#inflight).accessToken;
  }

  invalidate(): void {
    this.#token = null;
  }
}

export function wiqlFor(anchorId: number): string {
  return (
    `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${anchorId}) ` +
    `AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') ` +
    `AND ([Target].[System.State] NOT IN ('Closed','Removed')) MODE (Recursive)`
  );
}

/**
 * The stories a PM's stars come from: everything under the anchor but `Removed`, closed ones
 * included, so a story that closed before Orbit saw its PR merge still counts.
 */
export function shippedWiqlFor(anchorId: number, since: string): string {
  return (
    `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${anchorId}) ` +
    `AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') ` +
    `AND ([Target].[System.State] <> 'Removed') AND ([Target].[System.ChangedDate] >= '${since}') ` +
    `MODE (Recursive)`
  );
}

interface IterationNode {
  name?: string;
  attributes?: { startDate?: string; finishDate?: string };
  children?: IterationNode[];
}

/** Local midnight on an ADO date's day, `days` later; ADO writes its sprint days as UTC midnight. */
function localDay(iso: string, days = 0): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d + days).getTime();
}

/** The project's top-level iterations that have both dates, as windows; the last day is inclusive. */
export function parseSprints(root: IterationNode, project: string): SprintWindow[] {
  return (root.children ?? []).flatMap((n) => {
    const { startDate, finishDate } = n.attributes ?? {};
    if (!n.name || !startDate || !finishDate) return [];
    return [
      { name: n.name, path: `${project}\\${n.name}`, start: localDay(startDate), finish: localDay(finishDate, 1) },
    ];
  });
}

interface WiqlResponse {
  workItemRelations?: Array<{ target?: { id: number } }>;
}

interface BatchItem {
  id: number;
  fields: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string; attributes?: { name?: string; comment?: string } }>;
}

/** Container types are structure, not work; the board shows what people pick up. */
const CONTAINER_TYPES = new Set(['Epic', 'Feature']);

export function idsFromWiql(res: WiqlResponse, anchorId: number): number[] {
  const ids = new Set<number>();
  for (const r of res.workItemRelations ?? []) if (r.target && r.target.id !== anchorId) ids.add(r.target.id);
  return [...ids];
}

export function workItemUrl(org: string, project: string, id: number): string {
  return `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`;
}

/** One work item, containers included. */
function toItem(it: BatchItem, org: string, project: string): AdoItem {
  const f = it.fields ?? {};
  const assigned = f['System.AssignedTo'] as { displayName?: string } | string | undefined;
  const prNumbers: number[] = [];
  let parentId: number | null = typeof f['System.Parent'] === 'number' ? (f['System.Parent'] as number) : null;
  for (const rel of it.relations ?? []) {
    if (rel.rel === 'ArtifactLink') {
      const m = /GitHub\/PullRequest\/[^/%]+%2f(\d+)/i.exec(rel.url);
      if (m) prNumbers.push(Number(m[1]));
    } else if (rel.rel === 'System.LinkTypes.Hierarchy-Reverse' && parentId === null) {
      const m = /workItems\/(\d+)$/.exec(rel.url);
      if (m) parentId = Number(m[1]);
    }
  }
  return {
    id: it.id,
    title: String(f['System.Title'] ?? ''),
    type: String(f['System.WorkItemType'] ?? ''),
    state: String(f['System.State'] ?? ''),
    assignedTo: typeof assigned === 'string' ? assigned : (assigned?.displayName ?? null),
    parentId,
    prNumbers,
    url: workItemUrl(org, project, it.id),
    iterationPath: typeof f['System.IterationPath'] === 'string' ? f['System.IterationPath'] : null,
  };
}

export function mapBatch(items: BatchItem[], org: string, project: string): AdoItem[] {
  return items
    .filter((it) => !CONTAINER_TYPES.has(String(it.fields?.['System.WorkItemType'] ?? '')))
    .map((it) => toItem(it, org, project))
    .sort((a, b) => a.id - b.id);
}

/** An ADO work item as any tracker's item; its stage is provisional until the board's columns are known. */
export function toTrackerItem(i: AdoItem): TrackerItem {
  return {
    id: String(i.id),
    key: String(i.id),
    title: i.title,
    type: i.type,
    column: i.state,
    stage: stageOf(i.state, null),
    assignedTo: i.assignedTo,
    parentId: i.parentId === null ? null : String(i.parentId),
    prs: i.prNumbers.map((number) => ({ repo: null, number })),
    url: i.url,
    sprint: i.iterationPath,
  };
}

const ADO_CATEGORY: Record<string, StateCategory> = {
  Proposed: 'proposed',
  InProgress: 'in-progress',
  Resolved: 'resolved',
  Completed: 'completed',
  Removed: 'removed',
};

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** The ADO org a REST URL is for, so an auth failure names the sign-in. */
const orgOf = (url: string) => /dev\.azure\.com\/([^/]+)/.exec(url)?.[1] ?? '';

/** A work item in full, for get_story. */
export interface AdoWorkItem {
  item: AdoItem;
  fields: Record<string, unknown>;
  childIds: number[];
  links: Array<{ title: string; url: string }>;
}

export class AdoClient {
  readonly #tokens: AdoTokenProvider;
  readonly #fetch: FetchLike;

  constructor(tokens: AdoTokenProvider, fetchFn: FetchLike = fetch as unknown as FetchLike) {
    this.#tokens = tokens;
    this.#fetch = fetchFn;
  }

  async fetchSprints(org: string, project: string): Promise<SprintWindow[]> {
    const url = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/classificationnodes/Iterations?$depth=1&api-version=7.1`;
    return parseSprints((await this.#send(url)) as IterationNode, project);
  }

  items(cfg: AdoTrackerConfig): Promise<AdoItem[]> {
    return this.#itemsFor(cfg, wiqlFor(cfg.anchorId));
  }

  /** The PM's stories changed since `since` (a `YYYY-MM-DD` day), closed ones included. */
  shippedItems(cfg: AdoTrackerConfig, since: string): Promise<AdoItem[]> {
    return this.#itemsFor(cfg, shippedWiqlFor(cfg.anchorId, since));
  }

  async typeStates(org: string, project: string, type: string): Promise<TypeState[]> {
    const res = (await this.#send(
      `${witBase(org, project)}/workitemtypes/${encodeURIComponent(type)}/states?api-version=7.1`,
    )) as { value?: Array<{ name?: string; color?: string; category?: string }> };
    return (res.value ?? []).flatMap((s) =>
      s.name
        ? [{ name: s.name, category: ADO_CATEGORY[s.category ?? ''] ?? 'in-progress', color: s.color ?? null }]
        : [],
    );
  }

  async workItem(org: string, project: string, id: string): Promise<AdoWorkItem> {
    const it = (await this.#send(
      `${witBase(org, project)}/workitems/${encodeURIComponent(id)}?$expand=relations&api-version=7.1`,
    )) as BatchItem;
    const rels = it.relations ?? [];
    const childIds = rels.flatMap((r) => {
      const m = r.rel === 'System.LinkTypes.Hierarchy-Forward' ? /workItems\/(\d+)$/i.exec(r.url) : null;
      return m ? [Number(m[1])] : [];
    });
    const links = rels
      .filter((r) => r.rel === 'Hyperlink' || r.rel === 'AttachedFile')
      .map((r) => ({ title: r.attributes?.name ?? r.attributes?.comment ?? r.url, url: r.url }));
    return { item: toItem(it, org, project), fields: it.fields ?? {}, childIds, links };
  }

  async batch(org: string, project: string, ids: number[]): Promise<AdoItem[]> {
    const items: BatchItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const res = (await this.#send(`${witBase(org, project)}/workitemsbatch?api-version=7.1`, {
        ids: ids.slice(i, i + 200),
        $expand: 'relations',
      })) as { value?: BatchItem[] };
      items.push(...(res.value ?? []));
    }
    return mapBatch(items, org, project);
  }

  async comments(org: string, project: string, id: string): Promise<StoryComment[]> {
    const res = (await this.#send(
      `${witBase(org, project)}/workItems/${encodeURIComponent(id)}/comments?api-version=7.1-preview.4`,
    )) as { comments?: Array<{ text?: string; createdBy?: { displayName?: string }; createdDate?: string }> };
    return (res.comments ?? []).map((c) => ({
      author: c.createdBy?.displayName ?? '',
      at: c.createdDate ? Date.parse(c.createdDate) : 0,
      text: htmlToText(c.text ?? ''),
    }));
  }

  /** Sets the work item's state; ADO refusing the state comes back as a TrackerMoveError. */
  async setState(org: string, project: string, id: string, state: string): Promise<void> {
    const url = `${witBase(org, project)}/workitems/${encodeURIComponent(id)}?api-version=7.1`;
    const patch = [{ op: 'add', path: '/fields/System.State', value: state }];
    try {
      await this.#send(url, patch, { method: 'PATCH', contentType: 'application/json-patch+json' });
    } catch (e) {
      if (/^ADO 400\b/.test((e as Error).message)) throw new TrackerMoveError((e as Error).message);
      throw e;
    }
  }

  async addComment(org: string, project: string, id: string, text: string): Promise<void> {
    await this.#send(
      `${witBase(org, project)}/workItems/${encodeURIComponent(id)}/comments?api-version=7.1-preview.4`,
      {
        text,
      },
    );
  }

  async #itemsFor(cfg: AdoTrackerConfig, query: string): Promise<AdoItem[]> {
    const { org, project, anchorId } = cfg;
    const wiql = (await this.#send(`${witBase(org, project)}/wiql?api-version=7.1`, { query })) as WiqlResponse;
    const ids = idsFromWiql(wiql, anchorId);
    return ids.length ? this.batch(org, project, ids) : [];
  }

  /** POST `body` as JSON, or GET when there is none; `opts` picks another method or content type. */
  async #send(url: string, body?: unknown, opts: { method?: string; contentType?: string } = {}): Promise<unknown> {
    const ref = { kind: 'ado' as const, site: orgOf(url) };
    let token: string;
    try {
      token = await this.#tokens.get();
    } catch (e) {
      throw new TrackerAuthError(ref, (e as Error).message);
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
    const res = await this.#fetch(url, {
      method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 || res.status === 403) {
      this.#tokens.invalidate();
      throw new TrackerAuthError(ref, `ADO ${res.status}: token rejected`);
    }
    if (!res.ok) throw new Error(`ADO ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

const witBase = (org: string, project: string) =>
  `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit`;

/** An ADO project's board behind the tracker interface. */
export class AdoAdapter implements Tracker {
  readonly ref: TrackerRef;
  readonly #cfg: AdoTrackerConfig;
  readonly #client: AdoClient;
  #columns: BoardColumn[] = [];
  /** Each work item type's real states. The palette names states a process may not have. */
  readonly #typeStates = new Map<string, Set<string>>();
  /** Each item's type, from the last board read. */
  readonly #types = new Map<string, string>();

  constructor(cfg: AdoTrackerConfig, client: AdoClient) {
    this.#cfg = cfg;
    this.#client = client;
    this.ref = { kind: 'ado', site: cfg.org };
  }

  async board(): Promise<{ columns: BoardColumn[]; items: TrackerItem[] }> {
    const { org, project, stages } = this.#cfg;
    const raw = await this.#client.items(this.#cfg);
    const types = [...new Set(raw.map((i) => i.type))];
    const states = await Promise.all(types.map((t) => this.#client.typeStates(org, project, t)));
    types.forEach((t, i) => this.#typeStates.set(t, new Set(states[i].map((s) => s.name))));
    for (const i of raw) this.#types.set(String(i.id), i.type);
    this.#columns = adoColumns(states, stages);
    return { columns: this.#columns, items: withStages(raw.map(toTrackerItem), this.#columns, stages) };
  }

  async shipped(since: string): Promise<TrackerItem[]> {
    const raw = await this.#client.shippedItems(this.#cfg, since);
    return withStages(raw.map(toTrackerItem), this.#columns, this.#cfg.stages);
  }

  sprints(): Promise<SprintWindow[]> {
    return this.#client.fetchSprints(this.#cfg.org, this.#cfg.project);
  }

  async story(id: string): Promise<StoryDetail> {
    const { org, project, stages } = this.#cfg;
    const [wi, comments] = await Promise.all([
      this.#client.workItem(org, project, id),
      this.#client.comments(org, project, id),
    ]);
    const children = wi.childIds.length ? await this.#client.batch(org, project, wi.childIds) : [];
    const text = (field: string) => htmlToText(String(wi.fields[field] ?? ''));
    return {
      item: withStages([toTrackerItem(wi.item)], this.#columns, stages)[0],
      description: text('System.Description'),
      acceptance: text('Microsoft.VSTS.Common.AcceptanceCriteria') || null,
      comments,
      children: withStages(children.map(toTrackerItem), this.#columns, stages),
      links: wi.links,
    };
  }

  async move(id: string, stage: OrbitStage, note?: string): Promise<BoardColumn> {
    if (!this.#columns.length) await this.board();
    const real = await this.#statesOf(id);
    const reachable = this.#columns.filter((c) => real.has(c.name));
    const column = columnFor(stage, reachable);
    if (!column) throw noColumnError(stage, reachable);
    await this.#client.setState(this.#cfg.org, this.#cfg.project, id, column.name);
    if (note) await this.comment(id, note);
    return column;
  }

  comment(id: string, text: string): Promise<void> {
    return this.#client.addComment(this.#cfg.org, this.#cfg.project, id, text);
  }

  /** The states this item's type can be set to, asked of ADO once per type. */
  async #statesOf(id: string): Promise<Set<string>> {
    const { org, project } = this.#cfg;
    const type = this.#types.get(id) ?? (await this.#client.workItem(org, project, id)).item.type;
    let states = this.#typeStates.get(type);
    if (!states) {
      states = new Set((await this.#client.typeStates(org, project, type)).map((s) => s.name));
      this.#typeStates.set(type, states);
    }
    return states;
  }
}
