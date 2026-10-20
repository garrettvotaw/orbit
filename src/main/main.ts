import { app, clipboard, dialog, ipcMain, safeStorage, shell as electronShell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  IPC,
  type CommandResult,
  type OrbitCommand,
  type OrbitEvent,
  type OrbitRequest,
  type OrbitResponse,
} from '../shared/ipc.ts';
import {
  STORY_DONE,
  type AgentOption,
  type FeedEntry,
  type LaneConfig,
  type ModelOption,
  type OrbitConfig,
  type Snapshot,
} from '../shared/types.ts';
import { AdoClient, AdoTokenProvider } from './trackers/ado.ts';
import { trackerOf } from './trackers/config.ts';
import { JiraClient, type JiraCreds } from './trackers/jira.ts';
import { TrackerPoller } from './trackers/poller.ts';
import { TrackerRegistry } from './trackers/registry.ts';
import { SecretStore, jiraSecretKey } from './secrets.ts';
import { AttentionQueue } from './attention.ts';
import { agentColors, listAgents, listModels } from './catalog.ts';
import { ChildTracker, type SpawnRequest } from './children.ts';
import {
  DecisionStore,
  decisionTools,
  deliverAnswers as deliverAnswersTo,
  orbitServer,
  rerouteAnswers as rerouteAnswersTo,
  withdrawnMessage,
} from './decisions.ts';
import { boardTool, laneTools, reviewTool } from './lane-tools.ts';
import { boardToolsFor, type BoardAccess } from './board-tools.ts';
import {
  STORY_AGENT,
  STORY_RETENTION_MS,
  STORY_WIP_CAP,
  StoryStore,
  capStoryModel,
  deliverMail,
  dismissStory,
  forwardAnswer,
  moonTools,
  pmStoryTools,
  storyConfig,
  storyInfo,
  sweepStories,
  unstartedMoons,
  wakeWaiting,
  type MoonHost,
} from './stories.ts';
import { MemoryGuard, listProcesses } from './guard.ts';
import { DEFAULT_THRESHOLDS } from './memory.ts';
import { TestSlots } from './slots.ts';
import {
  defaultUserName,
  addLaneToConfig,
  defaultConfigPath,
  expandHome,
  lanesOf,
  loadConfig,
  removeLaneFromConfig,
  saveConfig,
  setLaneModel,
  setReviewModel,
  setTheme,
  validateConfig,
  watchConfig,
} from './config.ts';
import { FeedReader } from './feed-reader.ts';
import { GitHubPrs, fetchMerged, ghRunner } from './github.ts';
import { postFromLane } from './review-post.ts';
import { ConfigLock } from './lock.ts';
import { planMorning, runMorning } from './morning.ts';
import { PrBoardReader } from './pr-board.ts';
import { PrWatcher, changeLines } from './pr-watch.ts';
import { Scheduler } from './scheduler.ts';
import { SessionHost, type QueryFactory } from './session-host.ts';
import { openDb } from './db.ts';
import { importLegacy } from './legacy.ts';
import { reviewLaneId } from '../shared/review.ts';
import { RepoResolver } from './repos.ts';
import { StarStore, StarWatcher } from './stars.ts';
import { Shell } from './shell.ts';
import { createStateSaver, loadState } from './state-store.ts';

/** A fixture snapshot may also carry feeds keyed `${laneId}:${agentId ?? 'pm'}`, agents, and models for the UI. */
type Fixture = Partial<Snapshot> & {
  feeds?: Record<string, FeedEntry[]>;
  agents?: AgentOption[];
  models?: ModelOption[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const rendererIndex = path.join(root, 'src/renderer/dist/orbit-renderer/browser/index.html');
const configFile = process.env.ORBIT_CONFIG ?? defaultConfigPath();
// Data lives beside its config, so an alternate config (tests, experiments) never resumes the real lanes.
const dataDir = process.env.ORBIT_CONFIG ? path.dirname(configFile) : path.join(homedir(), '.claude', 'orbit');
const dbFile = path.join(dataDir, 'orbit.db');

/** A terminal running `command`, for a sign-in that has to show you a one-time code (gh). */
function openTerminal(command: string): void {
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "${command}"`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(`start "" cmd /k ${command}`, { shell: true, detached: true, stdio: 'ignore' }).unref();
  }
}

// Fixture and alternate-config runs (tests) get their own profile so they never share the
// single-instance lock or the disk cache with the real Orbit sitting in the tray.
if (process.env.ORBIT_FIXTURE || process.env.ORBIT_CONFIG) {
  app.setPath('userData', path.join(app.getPath('temp'), `orbit-${process.pid}`));
}

// Toasts need the id the installer stamped on the Start Menu shortcut; a dev run has no such
// shortcut, so the exe path stands in for it.
app.setAppUserModelId(app.isPackaged ? 'com.garrettvotaw.orbit' : process.execPath);

// A second launch (for example from the desktop shortcut while Orbit sits in the tray) must
// not start a second set of PM sessions; it hands off to the running instance instead.
// `electron . --quit` asks that instance to shut down and never starts one of its own.
const quitOnly = process.argv.includes('--quit');
if (!app.requestSingleInstanceLock({ quit: quitOnly }) || quitOnly) {
  app.quit();
}

process.on('warning', (w) => {
  if ((w as { code?: string }).code !== 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') console.warn(w);
});

app.whenReady().then(() => {
  if (quitOnly || !app.hasSingleInstanceLock()) return;
  let config: OrbitConfig;
  try {
    config = loadConfig(configFile);
  } catch (e) {
    dialog.showErrorBox('Orbit cannot start', `${(e as Error).message}\n\nConfig: ${configFile}`);
    app.quit();
    return;
  }

  const configLock = new ConfigLock(path.dirname(configFile));
  const other = process.env.ORBIT_FIXTURE ? null : configLock.acquire();
  if (other) {
    dialog.showErrorBox(
      'Orbit is already running',
      `Another Orbit is driving this config from:\n${other.exe}\n\nQuit it from its tray icon first, then start this one.\n\nConfig: ${configFile}`,
    );
    app.quit();
    return;
  }
  app.on('will-quit', () => configLock.release());

  const fixture: Fixture | null = process.env.ORBIT_FIXTURE
    ? (JSON.parse(readFileSync(process.env.ORBIT_FIXTURE, 'utf8')) as Fixture)
    : null;

  // A fixture run keeps its data in memory, so a test never reads or migrates the real profile.
  const db = openDb(fixture ? ':memory:' : dbFile);
  if (!fixture) {
    const moved = importLegacy(db, dataDir);
    if (moved.length) console.log(`Orbit: moved ${moved.join(', ')} into ${dbFile}`);
  }
  const attention = new AttentionQueue();
  const children = new ChildTracker();
  const decisions = new DecisionStore(db);
  const stories = new StoryStore(db);
  const stars = new StarStore(db);
  // Every lane but a chat gets needs_you, withdraw_needs_you, and post_status. PM sessions add
  // report_board, the product-question tools and, unless storyMoons is off, the story tools;
  // story moons add product questions tagged with their story plus claim_files and report_to_pm;
  // monitors add the product-question tools; reviews add review_preview.
  // Read when a lane starts, by which time the tracker registry and poller below exist.
  const boardAccess: BoardAccess = {
    tracker: (id) => registry.for(id),
    board: (id) => trackerBoards.board(id),
    refresh: (id) => trackerBoards.refresh(id),
  };
  const boardToolsOf = (cfg: LaneConfig) =>
    boardToolsFor(cfg, config, boardAccess, (id) => stories.get(id)?.parentId ?? null);
  // What the lanes call whoever reads Orbit, and the words a product question may use.
  const who = () => config.userName ?? defaultUserName(userInfo().username);
  const askOpts = () => ({ who: who(), productTerms: config.productTerms ?? [] });
  const toolsFor = (cfg: LaneConfig): Record<string, unknown> | null => {
    if (cfg.kind === 'chat') return null;
    const own = laneTools(host, { id: cfg.id, story: cfg.kind === 'story' ? cfg.storyId : null }, who());
    if (cfg.kind === 'review') return { orbit: orbitServer([...own, reviewTool(host, cfg, who())]) };
    if (cfg.kind === 'project') {
      const tools: unknown[] = [
        ...own,
        boardTool(host, cfg),
        ...decisionTools(decisions, { id: cfg.id, name: cfg.name }, askOpts()),
        ...boardToolsOf(cfg),
      ];
      if (config.storyMoons !== false)
        tools.push(
          ...pmStoryTools(stories, moons, cfg, {
            cap: config.storyWipCap ?? STORY_WIP_CAP,
            model: capStoryModel(config.storyModel ?? cfg.model),
            agent: config.storyAgent ?? STORY_AGENT,
          }),
        );
      return { orbit: orbitServer(tools) };
    }
    if (cfg.kind === 'story')
      return {
        orbit: orbitServer([
          ...own,
          ...decisionTools(decisions, { id: cfg.id, name: cfg.name, story: cfg.storyId }, askOpts()),
          ...moonTools(stories, moons, cfg),
          ...boardToolsOf(cfg),
        ]),
      };
    return { orbit: orbitServer([...own, ...decisionTools(decisions, { id: cfg.id, name: cfg.name }, askOpts())]) };
  };
  // Heavy test and build commands from every lane share these slots; low memory cuts them down.
  const testSlots = config.testSlots ?? 2;
  const slots = new TestSlots({ base: testSlots });
  const guard = new MemoryGuard({
    sample: () => process.getSystemMemoryInfo(),
    slots,
    testSlots,
    thresholds: {
      holdGb: config.memoryHoldGb ?? DEFAULT_THRESHOLDS.holdGb,
      resumeGb: config.memoryResumeGb ?? DEFAULT_THRESHOLDS.resumeGb,
      criticalGb: config.memoryCriticalGb ?? DEFAULT_THRESHOLDS.criticalGb,
    },
    releaseHeld: () => void host.releaseHeld(),
    alert: (message) => {
      const laneId = config.projects[0]?.id ?? lanesOf(config)[0]?.id;
      if (laneId) attention.raiseError(laneId, 'memory', message);
      else console.warn(`Orbit: ${message}`);
    },
    topProcesses: listProcesses,
    nameOf: (id) => stories.get(id)?.storyId ?? host.lane(id)?.name ?? id,
  });
  const host: SessionHost = new SessionHost({
    query: query as unknown as QueryFactory,
    attention,
    baseOptions: { spawnClaudeCodeProcess: (o: SpawnRequest) => children.spawn(o) },
    toolsFor: (cfg) => toolsFor(cfg),
    slots,
    admit: () => guard.admits(),
    killLane: (id) => children.killLane(id),
    userName: () => who(),
  });
  // Launches a PM or Orbit asks for wait for memory, and a held moon counts as up so its mail
  // waits for it. Your own clicks go to the host directly and never wait.
  const moons: MoonHost = {
    isLive: (id) => host.isLive(id) || host.isHeld(id),
    lane: (id) => host.lane(id),
    send: (id, text, priority) => host.send(id, text, priority),
    addTransient: (cfg) => host.addTransient(cfg),
    removeTransient: (id) => host.removeTransient(id),
    start: (id) => host.startWhenRoom(id),
    resume: (id, sessionId) => host.resumeWhenRoom(id, sessionId),
    stop: (id) => host.stop(id),
    held: (id) => host.isHeld(id),
  };
  const shell = new Shell({
    rendererIndex,
    preload: path.join(here, 'preload.cjs'),
    assets: path.join(root, 'assets'),
    onMorning: () => morning(),
    onEvening: () => void host.stopAll(),
    toastEnabled: () => config.alerts.toast,
  });
  const emit = (e: OrbitEvent) => shell.send(IPC.event, e);
  const saveState = createStateSaver(db, () => host.accounting());
  const feeds = new FeedReader();

  const adoClient = new AdoClient(new AdoTokenProvider());
  const gh = ghRunner();
  // az and gh keep their own sign-ins; Jira's email and token live encrypted in orbit.db.
  const secrets = new SecretStore(db, {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
  });
  const jiraCreds = (site: string): JiraCreds | null => {
    try {
      const raw = secrets.get(jiraSecretKey(site));
      return raw ? (JSON.parse(raw) as JiraCreds) : null;
    } catch (e) {
      console.warn(`Orbit: could not read the Jira sign-in for ${site}: ${(e as Error).message}`);
      return null;
    }
  };
  const registry = new TrackerRegistry({
    ado: adoClient,
    jira: (site) => new JiraClient(site, () => jiraCreds(site)),
    gh,
  });
  const trackerBoards = new TrackerPoller({
    trackers: registry,
    onAuthError: (projectId, ref, message) => attention.raiseError(projectId, 'tracker-auth', message, ref),
    onBoards: () => publish(),
  });
  const prBoards = new PrBoardReader(() => publish());
  // A PR merged on a PM's story is a star in the sprint it merged in. Merges are looked for each
  // time the Reviews list refreshes, on the same clock.
  const repos = new RepoResolver(gh);
  const starWatcher = new StarWatcher({
    trackers: registry,
    repos,
    merged: (repo, since) => fetchMerged(gh, repo, since),
    moonPrs: (pmId) =>
      stories
        .list()
        .filter((r) => r.parentId === pmId && r.pr !== null)
        .map((r) => ({ storyId: r.storyId, pr: r.pr as number })),
    onStars: (found) => stars.add(found),
    onError: (message) => console.warn(`Orbit stars: ${message}`),
  });
  const teamPrs = new GitHubPrs(() => {
    publish();
    void starWatcher.refresh().then(publish);
  }, gh);
  const scheduler = new Scheduler({ host, onTick: (id) => prBoards.refresh(id) });
  const prWatcher = new PrWatcher({
    onChange: (id, changes) => scheduler.wake(id, changeLines(changes)),
    onError: (id, message) => console.warn(`Orbit PR watcher (${id}): ${message}`),
  });
  const sweepTimer = setInterval(() => {
    host.sweep();
    if (!fixture)
      void sweepStories(stories, host, Date.now(), STORY_RETENTION_MS).catch((e: Error) =>
        console.warn(`Orbit story sweep: ${e.message}`),
      );
  }, 60_000);
  sweepTimer.unref();
  // Agent files change rarely; re-read them when the lane folders change rather than per snapshot.
  let colors: Record<string, string> = {};

  const snapshot = (): Snapshot => {
    if (fixture) {
      return {
        lanes: fixture.lanes ?? [],
        attention: fixture.attention ?? [],
        spentTodayUsd: fixture.spentTodayUsd ?? 0,
        boards: fixture.boards ?? [],
        prBoards: fixture.prBoards ?? [],
        teamPrs: fixture.teamPrs ?? { repos: [], fetchedAt: 0, prs: [], error: null },
        agentColors: fixture.agentColors ?? {},
        decisions: fixture.decisions ?? [],
        stars: fixture.stars ?? [],
        sprints: fixture.sprints ?? {},
        ...(fixture.guard ? { guard: fixture.guard } : {}),
      };
    }
    const live = host.snapshot();
    const line = slots.view();
    return {
      ...live,
      // A moon's stage, PR, and claimed files live in the story store, not the session.
      lanes: live.lanes.map((l) => {
        const rec = l.kind === 'story' ? stories.get(l.id) : undefined;
        return rec ? { ...l, story: storyInfo(rec) } : l;
      }),
      boards: trackerBoards.boards(),
      prBoards: prBoards.boards(),
      teamPrs: teamPrs.board(),
      agentColors: colors,
      decisions: decisions.list(),
      stars: stars.list(),
      sprints: starWatcher.skies(),
      guard: { ...guard.view(), slots: line.slots, waiting: [...line.waiting, ...host.heldView()] },
    };
  };
  let publishQueued = false;
  const publish = () => {
    if (publishQueued) return;
    publishQueued = true;
    setImmediate(() => {
      publishQueued = false;
      const s = snapshot();
      emit({ type: 'snapshot', snapshot: s });
      shell.reflect(s);
    });
  };

  /** Keeps a Jira sign-in typed on the card, clears that site's cards, and polls its boards again. */
  const saveJiraLogin = (site: string, email: string, token: string) => {
    secrets.set(jiraSecretKey(site), JSON.stringify({ email: email.trim(), token: token.trim() }));
    trackerBoards.forget({ kind: 'jira', site });
    for (const item of attention.items()) {
      if (item.kind === 'error' && item.code === 'tracker-auth' && item.tracker?.site === site)
        attention.dismiss(item.id);
    }
    for (const p of config.projects) {
      const t = trackerOf(p);
      if (t?.kind === 'jira' && t.site === site) void trackerBoards.refresh(p.id);
    }
  };

  const morning = () =>
    runMorning(
      planMorning(config.morning, (id) => host.isLive(id)),
      (id) => host.start(id),
    );

  const applyConfig = (c: OrbitConfig) => {
    config = c;
    host.setLanes(lanesOf(c));
    if (!fixture) {
      registry.setProjects(c.projects);
      trackerBoards.setProjects(c.projects, c.adoPollMinutes);
      repos.setConfig(c);
      starWatcher.setProjects(c.projects);
      prBoards.setMonitors(c.monitors);
      scheduler.setMonitors(c.monitors);
      prWatcher.setMonitors(c.monitors, () => repos.all());
      teamPrs.configure({ repos: () => repos.all() });
      colors = agentColors(lanesOf(c).map((l) => l.cwd));
    }
    emit({ type: 'config', config: c });
    shell.setTheme(c.theme ?? 'dark');
  };

  host.setLanes(lanesOf(config));
  // Moons outlive a restart: back on the stage as stopped lanes, resumable like any other.
  for (const rec of stories.list()) host.addTransient(storyConfig(rec));
  const saved = loadState(db);
  host.hydrate(saved.lanes);
  host.hydrateAccounting(saved);
  const reportSeen = new Map<string, number>();
  const deliverAnswers = (laneId: string) => deliverAnswersTo(decisions, host, laneId);
  const rerouteAnswers = () =>
    rerouteAnswersTo(decisions, host, (laneId) => {
      const rec = stories.get(laneId);
      return rec ? { parentId: rec.parentId, finished: STORY_DONE.includes(rec.stage) } : null;
    });
  host.onChange((s) => {
    saveState(s);
    publish();
    scheduler.flush();
    rerouteAnswers();
    for (const lane of s.lanes) {
      const at = lane.lastReport?.at ?? 0;
      if (lane.kind === 'project' && at && reportSeen.get(lane.id) !== at) {
        reportSeen.set(lane.id, at);
        void trackerBoards.refresh(lane.id);
      }
      if (lane.status === 'idle') {
        deliverAnswers(lane.id);
        deliverMail(stories, host, lane.id);
      }
    }
  });
  // Files free up when a story finishes, leaves, or lets go to break a loop; the stories waiting
  // on them wake then. Waking changes the store too, so it never starts again from inside itself.
  let waking = false;
  const wake = () => {
    if (waking) return;
    waking = true;
    try {
      wakeWaiting(stories, moons);
    } finally {
      waking = false;
    }
  };
  slots.onChange(() => publish());
  guard.onChange(() => publish());
  const stopGuard = fixture ? () => {} : guard.start();
  // A moon that never got a session (held for memory when Orbit last closed) starts once there's room.
  if (!fixture) for (const id of unstartedMoons(stories, host)) host.startWhenRoom(id);
  stories.onChange(() => {
    publish();
    wake();
  });
  wake();
  stars.onChange(() => publish());
  decisions.onChange((arrived) => {
    publish();
    rerouteAnswers();
    if (arrived && config.alerts.toast) shell.toastText(`${arrived.laneName} has a product question`, arrived.question);
  });

  watchConfig(configFile, applyConfig, (e) => console.error(`Orbit config: ${e.message}`));

  ipcMain.handle(IPC.command, async (_e, cmd: OrbitCommand) => {
    switch (cmd.type) {
      case 'start':
        host.start(cmd.laneId);
        break;
      case 'resume': {
        const sid = host.lane(cmd.laneId)?.sessionId;
        if (sid) host.resume(cmd.laneId, sid);
        else host.start(cmd.laneId);
        break;
      }
      case 'fresh':
        await host.fresh(cmd.laneId);
        break;
      case 'stop':
        await host.stop(cmd.laneId);
        break;
      case 'morning':
        morning();
        break;
      case 'evening':
        await host.stopAll();
        break;
      case 'send':
        // A fixture has no sessions to deliver to; it stands in for a lane that took the message.
        return {
          delivered: fixture ? true : host.send(cmd.laneId, cmd.text, cmd.priority, cmd.images ?? []),
        } satisfies CommandResult;
      case 'answer':
        attention.answer(cmd.attentionId, cmd.answers, cmd.annotations);
        break;
      case 'dismiss':
        attention.dismiss(cmd.attentionId);
        break;
      case 'ssoLogin': {
        const profile = (process.env.AWS_PROFILE ?? 'default').replace(/[^\w.-]/g, '');
        spawn(`aws sso login --profile "${profile}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        break;
      }
      case 'trackerLogin': {
        const project = config.projects.find((p) => p.id === cmd.laneId);
        const kind = project ? trackerOf(project)?.kind : undefined;
        if (kind === 'ado') spawn('az login', { shell: true, detached: true, stdio: 'ignore' }).unref();
        else if (kind === 'github') openTerminal('gh auth login');
        break;
      }
      case 'saveJiraLogin':
        if (!fixture) saveJiraLogin(cmd.site, cmd.email, cmd.token);
        break;
      case 'refreshBoard':
        if (host.lane(cmd.laneId)?.kind === 'monitor') prBoards.refresh(cmd.laneId);
        else void trackerBoards.refresh(cmd.laneId);
        break;
      case 'addLane': {
        if (fixture) break;
        const lane = { ...cmd.lane, cwd: expandHome(cmd.lane.cwd) } as LaneConfig;
        if (!existsSync(lane.cwd)) throw new Error(`Folder does not exist: ${lane.cwd}`);
        const next = addLaneToConfig(config, lane);
        validateConfig(next);
        saveConfig(configFile, next);
        applyConfig(next);
        break;
      }
      case 'removeLane': {
        if (host.isTransient(cmd.laneId)) {
          if (host.removeTransient(cmd.laneId)) stories.remove(cmd.laneId);
          break;
        }
        if (fixture || host.isLive(cmd.laneId)) break;
        const next = removeLaneFromConfig(config, cmd.laneId);
        saveConfig(configFile, next);
        applyConfig(next);
        break;
      }
      case 'dismissStory':
        if (!fixture) await dismissStory(stories, host, cmd.laneId);
        break;
      case 'reviewPr': {
        if (fixture) break;
        const pr = teamPrs.board().prs.find((p) => p.number === cmd.number && p.repo === cmd.repo);
        const repo = cmd.repo;
        const id = reviewLaneId(repo, cmd.number);
        if (!host.lane(id)) {
          const cwd = repos.folderFor(repo) ?? lanesOf(config)[0]?.cwd;
          if (!cwd) break;
          host.addTransient({
            kind: 'review',
            id,
            name: `#${cmd.number} review`,
            cwd,
            pr: cmd.number,
            repo,
            url: pr?.url ?? (repo ? `https://github.com/${repo}/pull/${cmd.number}` : ''),
            ...(config.reviewModel ? { model: config.reviewModel } : {}),
          });
        }
        if (!host.isLive(id)) host.start(id);
        break;
      }
      case 'setReviewModel': {
        if (fixture) break;
        const next = setReviewModel(config, cmd.model);
        saveConfig(configFile, next);
        config = next;
        emit({ type: 'config', config });
        break;
      }
      case 'postReview':
        // A fixture never reaches GitHub; its snapshot stands in for whatever came back.
        if (!fixture) await postFromLane(host, gh, cmd.laneId, cmd.dropped, cmd.pick);
        break;
      case 'refreshTeamPrs':
        if (!fixture) await teamPrs.refresh();
        break;
      case 'setModel': {
        await host.setModel(cmd.laneId, cmd.model);
        if (!fixture) {
          const next = setLaneModel(config, cmd.laneId, cmd.model);
          saveConfig(configFile, next);
          config = next;
        }
        break;
      }
      case 'openExternal':
        if (/^(https?:\/\/|mailto:)/.test(cmd.url)) await electronShell.openExternal(cmd.url);
        break;
      case 'copyText':
        clipboard.writeText(cmd.text);
        break;
      case 'answerDecision': {
        if (fixture) break;
        const d = decisions.answer(cmd.id, cmd.answer);
        if (d) {
          forwardAnswer(stories, host, d);
          deliverAnswers(d.laneId);
        }
        break;
      }
      case 'dismissDecision': {
        if (fixture) break;
        const d = decisions.dismiss(cmd.id);
        if (d && host.isLive(d.laneId)) host.send(d.laneId, withdrawnMessage(d), 'next');
        break;
      }
      case 'markDecisionsSent':
        if (!fixture) decisions.markSent(cmd.ids);
        break;
      case 'setTheme': {
        shell.setTheme(cmd.theme);
        if (fixture) break;
        const next = setTheme(config, cmd.theme);
        saveConfig(configFile, next);
        config = next;
        emit({ type: 'config', config });
        break;
      }
    }
  });

  ipcMain.handle(IPC.request, async (_e, req: OrbitRequest): Promise<OrbitResponse> => {
    switch (req.type) {
      case 'feed': {
        if (fixture) {
          const entries = fixture.feeds?.[`${req.laneId}:${req.agentId ?? 'pm'}`] ?? [];
          return { entries, note: entries.length ? null : 'No fixture feed.' };
        }
        const cwd = lanesOf(config).find((l) => l.id === req.laneId)?.cwd;
        return feeds.read(
          host.lane(req.laneId),
          cwd,
          req.agentId,
          host.isLive(req.laneId) ? host.feed(req.laneId) : null,
        );
      }
      case 'agents':
        return { agents: fixture ? (fixture.agents ?? []) : listAgents(expandHome(req.cwd)) };
      case 'models': {
        const seen = host
          .snapshot()
          .lanes.flatMap((l) => [l.model, l.requestedModel])
          .filter((m): m is string => !!m);
        return { models: fixture ? (fixture.models ?? []) : listModels({ live: await host.models(), seen }) };
      }
    }
  });

  const win = shell.create({ show: !process.argv.includes('--hidden') });
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    if ((data as { quit?: boolean } | undefined)?.quit) app.quit();
    else shell.show();
  });
  win.webContents.on('did-finish-load', () => {
    emit({ type: 'config', config });
    publish();
  });
  applyConfig(config);

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    clearInterval(sweepTimer);
    stopGuard();
    scheduler.stop();
    prWatcher.stop();
    trackerBoards.stop();
    prBoards.stop();
    teamPrs.stop();
    void host
      .stopAll()
      .then(() => children.killAll())
      .finally(() => app.quit());
  });
});

app.on('window-all-closed', () => {
  // stay in the tray
});
