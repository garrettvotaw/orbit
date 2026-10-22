import { Injectable, computed, signal } from '@angular/core';
import type {
  AgentsResponse,
  CommandResult,
  FeedResponse,
  ModelsResponse,
  OrbitCommand,
} from '../../../shared/ipc';
import type {
  TrackerBoard,
  AttentionItem,
  Decision,
  GuardView,
  ImageAttachment,
  Lane,
  ModelOption,
  OrbitConfig,
  PrBoard,
  Priority,
  SprintSky,
  Star,
  TeamPrBoard,
  Theme,
} from '../../../shared/types';
import { worldKinds, type WorldKind } from './pure/worlds';
import type { Screenshot } from './screenshots';

/** Before the first snapshot, or from a fixture without one: no reading yet, nothing in line. */
const NO_GUARD: GuardView = {
  headroomBytes: 0,
  totalBytes: 0,
  state: 'normal',
  slots: [],
  waiting: [],
};

export interface DrawerTarget {
  laneId: string;
  /** null means the PM's own feed. */
  agentId: string | null;
  title: string;
}

@Injectable({ providedIn: 'root' })
export class OrbitStore {
  readonly lanes = signal<Lane[]>([]);
  readonly attention = signal<AttentionItem[]>([]);
  readonly boards = signal<TrackerBoard[]>([]);
  readonly prBoards = signal<PrBoard[]>([]);
  readonly teamPrs = signal<TeamPrBoard>({ repos: [], fetchedAt: 0, prs: [], error: null });
  readonly agentColors = signal<Record<string, string>>({});
  readonly spentTodayUsd = signal(0);
  readonly decisions = signal<Decision[]>([]);
  readonly stars = signal<Star[]>([]);
  readonly sprints = signal<Record<string, SprintSky>>({});
  /** Free memory and the shared test slots. */
  readonly guard = signal<GuardView>(NO_GUARD);
  readonly decisionsOpen = signal(false);
  /** Your pick this session, until the saved config catches up. */
  readonly themeChoice = signal<Theme | null>(null);
  readonly systemDark = signal(window.matchMedia('(prefers-color-scheme: dark)').matches);
  readonly themeMode = computed<Theme>(() => this.themeChoice() ?? this.config()?.theme ?? 'dark');
  readonly dark = computed(() =>
    this.themeMode() === 'system' ? this.systemDark() : this.themeMode() === 'dark',
  );
  readonly config = signal<OrbitConfig | null>(null);
  readonly selectedLaneId = signal<string | null>(null);
  readonly boardOpen = signal(false);
  readonly drawer = signal<DrawerTarget | null>(null);
  readonly newOrbitOpen = signal(false);
  readonly reviewsOpen = signal(false);
  readonly models = signal<ModelOption[]>([]);
  /** What you have typed to each lane and not sent yet; kept when you switch lanes or close the panel. */
  readonly drafts = signal<Record<string, string>>({});
  /** The screenshots waiting to go with each lane's draft, kept the same way. */
  readonly screenshots = signal<Record<string, Screenshot[]>>({});
  readonly now = signal(Date.now());

  readonly selectedLane = computed(
    () => this.lanes().find((l) => l.id === this.selectedLaneId()) ?? null,
  );
  /** The lanes on the home row: everything but the story moons, which circle their PM. */
  readonly homeLanes = computed(() => this.lanes().filter((l) => !l.parentId));
  /** The world each home lane is drawn as, so no two share one until every kind is taken. */
  readonly worldKinds = computed(() => worldKinds(this.homeLanes().map((l) => l.id)));
  /** The lane the stage focuses on: a moon's PM when a moon is selected. */
  readonly focusLaneId = computed(() => {
    const lane = this.selectedLane();
    return lane ? (lane.parentId ?? lane.id) : null;
  });
  /** Where the focused lane sits on the home row. */
  readonly selectedIndex = computed(() => {
    const id = this.focusLaneId();
    const i = this.homeLanes().findIndex((l) => l.id === id);
    return i === -1 ? null : i;
  });
  readonly allLive = computed(() => {
    const cfg = this.config();
    return (
      !!cfg &&
      cfg.morning.every((id) =>
        this.lanes().some((l) => l.id === id && l.status !== 'stopped' && l.status !== 'error'),
      )
    );
  });
  /** Product questions still waiting on an answer, oldest first. */
  readonly openDecisions = computed(() => this.decisions().filter((d) => d.status === 'open'));
  /** Something is still running, so there is a day to end. */
  readonly anyLive = computed(() =>
    this.lanes().some((l) => l.status !== 'stopped' && l.status !== 'error'),
  );

  constructor() {
    window.orbit.onEvent((e) => {
      if (e.type === 'snapshot') {
        this.lanes.set(e.snapshot.lanes);
        this.attention.set(e.snapshot.attention);
        this.boards.set(e.snapshot.boards ?? []);
        this.prBoards.set(e.snapshot.prBoards ?? []);
        if (e.snapshot.teamPrs) this.teamPrs.set(e.snapshot.teamPrs);
        this.agentColors.set(e.snapshot.agentColors ?? {});
        this.spentTodayUsd.set(e.snapshot.spentTodayUsd ?? 0);
        this.decisions.set(e.snapshot.decisions ?? []);
        this.stars.set(e.snapshot.stars ?? []);
        this.sprints.set(e.snapshot.sprints ?? {});
        this.guard.set(e.snapshot.guard ?? NO_GUARD);
      } else {
        this.config.set(e.config);
      }
    });
    setInterval(() => this.now.set(Date.now()), 5_000);
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', (e) => this.systemDark.set(e.matches));
  }

  boardFor(laneId: string): TrackerBoard | null {
    return this.boards().find((b) => b.projectId === laneId) ?? null;
  }

  prBoardFor(laneId: string): PrBoard | null {
    return this.prBoards().find((b) => b.monitorId === laneId) ?? null;
  }

  laneName(laneId: string): string {
    return this.lanes().find((l) => l.id === laneId)?.name ?? laneId;
  }

  /** The world a home lane is drawn as; undefined for a moon or a lane not on the home row. */
  worldKindOf(id: string): WorldKind | undefined {
    return this.worldKinds().get(id);
  }

  /** The story moons circling a PM, oldest first. */
  moonsOf(laneId: string): Lane[] {
    return this.lanes().filter((l) => l.parentId === laneId);
  }

  /** Product questions a PM or any of its moons has raised. */
  decisionsAround(laneId: string): Decision[] {
    const ids = new Set([laneId, ...this.moonsOf(laneId).map((m) => m.id)]);
    return this.decisions().filter((d) => ids.has(d.laneId));
  }

  select(laneId: string | null): void {
    if (laneId !== this.selectedLaneId()) {
      this.boardOpen.set(false);
      this.drawer.set(null);
    }
    this.selectedLaneId.set(laneId);
  }

  openDrawer(target: DrawerTarget): void {
    this.drawer.set(target);
  }

  command(cmd: OrbitCommand): Promise<CommandResult | undefined> {
    return window.orbit.command(cmd);
  }

  /** Send a lane a message, with any screenshots; false when no running session took it. */
  async send(
    laneId: string,
    text: string,
    priority: Priority,
    images: ImageAttachment[] = [],
  ): Promise<boolean> {
    const r = await this.command({
      type: 'send',
      laneId,
      text,
      priority,
      ...(images.length
        ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) }
        : {}),
    });
    return r?.delivered ?? false;
  }

  feed(laneId: string, agentId: string | null): Promise<FeedResponse> {
    return window.orbit.request({ type: 'feed', laneId, agentId });
  }

  agents(cwd: string): Promise<AgentsResponse> {
    return window.orbit.request({ type: 'agents', cwd });
  }

  /** The PM domain files a folder has, relative to it. */
  async domainFiles(cwd: string): Promise<string[]> {
    return (await window.orbit.request({ type: 'listDomainFiles', cwd })).files;
  }

  async refreshModels(): Promise<ModelOption[]> {
    const { models } = await window.orbit.request({ type: 'models' });
    this.models.set(models);
    return models;
  }

  setTheme(theme: Theme): void {
    this.themeChoice.set(theme);
    void this.command({ type: 'setTheme', theme });
  }

  open(url: string): void {
    void this.command({ type: 'openExternal', url });
  }
}
