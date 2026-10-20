import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { LaneConfig, OrbitConfig, Theme } from '../shared/types.ts';
import { trackerOf, validateTracker } from './trackers/config.ts';

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

/** What the lanes call you without a userName: `Pat` from `pat.doe` or `pat_doe`. */
export function defaultUserName(login: string): string {
  const first = login.split(/[._\s-]/)[0] ?? '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'the user';
}

export function defaultConfigPath(): string {
  return path.join(homedir(), '.claude', 'orbit', 'config.json');
}

export function normalizeConfig(raw: Partial<OrbitConfig>): OrbitConfig {
  return {
    projects: (raw.projects ?? []).map((p) => ({ ...p, cwd: expandHome(p.cwd) })),
    monitors: (raw.monitors ?? []).map((m) => ({ ...m, cwd: expandHome(m.cwd), stateFile: expandHome(m.stateFile) })),
    chats: (raw.chats ?? []).map((c) => ({ ...c, cwd: expandHome(c.cwd) })),
    morning: raw.morning ?? [],
    alerts: { toast: raw.alerts?.toast ?? true, sound: raw.alerts?.sound ?? false },
    adoPollMinutes: raw.adoPollMinutes ?? 2,
    ...(raw.githubRepo ? { githubRepo: raw.githubRepo } : {}),
    ...(raw.reviewModel ? { reviewModel: raw.reviewModel } : {}),
    ...(raw.productOwnerEmail ? { productOwnerEmail: raw.productOwnerEmail } : {}),
    ...(raw.theme ? { theme: raw.theme } : {}),
    ...(raw.storyMoons === false ? { storyMoons: false } : {}),
    ...(raw.boardTools === false ? { boardTools: false as const } : {}),
    ...(raw.userName ? { userName: raw.userName } : {}),
    ...(raw.productTerms ? { productTerms: raw.productTerms } : {}),
    ...(raw.storyWipCap ? { storyWipCap: raw.storyWipCap } : {}),
    ...(raw.storyModel ? { storyModel: raw.storyModel } : {}),
    ...(raw.storyAgent ? { storyAgent: raw.storyAgent } : {}),
    ...(typeof raw.testSlots === 'number' ? { testSlots: raw.testSlots } : {}),
    ...(typeof raw.memoryHoldGb === 'number' ? { memoryHoldGb: raw.memoryHoldGb } : {}),
    ...(typeof raw.memoryResumeGb === 'number' ? { memoryResumeGb: raw.memoryResumeGb } : {}),
    ...(typeof raw.memoryCriticalGb === 'number' ? { memoryCriticalGb: raw.memoryCriticalGb } : {}),
  };
}

export function validateConfig(cfg: OrbitConfig): void {
  const seen = new Set<string>();
  for (const lane of lanesOf(cfg)) {
    if (seen.has(lane.id)) throw new Error(`config: duplicate lane id "${lane.id}"`);
    seen.add(lane.id);
    if (!existsSync(lane.cwd)) throw new Error(`config: lane "${lane.id}" cwd does not exist: ${lane.cwd}`);
  }
  for (const p of cfg.projects) {
    const t = trackerOf(p);
    if (t) validateTracker(t, p.id);
  }
  for (const id of cfg.morning) {
    if (!seen.has(id)) throw new Error(`config: morning lane "${id}" is not a project, monitor, or chat`);
  }
}

export function loadConfig(file: string): OrbitConfig {
  const cfg = normalizeConfig(JSON.parse(readFileSync(file, 'utf8')) as Partial<OrbitConfig>);
  validateConfig(cfg);
  return cfg;
}

export function saveConfig(file: string, cfg: OrbitConfig): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function lanesOf(cfg: OrbitConfig): LaneConfig[] {
  return [
    ...cfg.projects.map((p) => ({ kind: 'project' as const, ...p })),
    ...cfg.monitors.map((m) => ({ kind: 'monitor' as const, ...m })),
    ...cfg.chats.map((c) => ({ kind: 'chat' as const, ...c })),
  ];
}

/** A short id from a display name, made unique against the lanes already in the config. */
export function laneIdFor(name: string, cfg: OrbitConfig): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'lane';
  const taken = new Set(lanesOf(cfg).map((l) => l.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function addLaneToConfig(cfg: OrbitConfig, lane: LaneConfig): OrbitConfig {
  if (lanesOf(cfg).some((l) => l.id === lane.id)) throw new Error(`config: duplicate lane id "${lane.id}"`);
  const { kind, ...rest } = lane;
  switch (kind) {
    case 'project':
      return { ...cfg, projects: [...cfg.projects, rest as OrbitConfig['projects'][number]] };
    case 'monitor':
      return { ...cfg, monitors: [...cfg.monitors, rest as OrbitConfig['monitors'][number]] };
    case 'chat':
      return { ...cfg, chats: [...cfg.chats, rest as OrbitConfig['chats'][number]] };
    case 'review':
      throw new Error('config: review lanes are not saved; they live only while the app runs');
    case 'story':
      throw new Error('config: story lanes are not saved in the config; they live in stories.json');
  }
}

export function removeLaneFromConfig(cfg: OrbitConfig, id: string): OrbitConfig {
  return {
    ...cfg,
    projects: cfg.projects.filter((p) => p.id !== id),
    monitors: cfg.monitors.filter((m) => m.id !== id),
    chats: cfg.chats.filter((c) => c.id !== id),
    morning: cfg.morning.filter((m) => m !== id),
  };
}

export function setLaneModel(cfg: OrbitConfig, id: string, model: string | null): OrbitConfig {
  const apply = <T extends { id: string; model?: string }>(list: T[]): T[] =>
    list.map((l) => {
      if (l.id !== id) return l;
      const { model: _old, ...rest } = l;
      return (model ? { ...rest, model } : rest) as T;
    });
  return { ...cfg, projects: apply(cfg.projects), monitors: apply(cfg.monitors), chats: apply(cfg.chats) };
}

export function setTheme(cfg: OrbitConfig, theme: Theme): OrbitConfig {
  const { theme: _old, ...rest } = cfg;
  return theme === 'system' ? rest : { ...rest, theme };
}

export function setReviewModel(cfg: OrbitConfig, model: string | null): OrbitConfig {
  const { reviewModel: _old, ...rest } = cfg;
  return model ? { ...rest, reviewModel: model } : rest;
}

export function watchConfig(
  file: string,
  cb: (cfg: OrbitConfig) => void,
  onError: (e: Error) => void = () => {},
): () => void {
  let timer: NodeJS.Timeout | null = null;
  const w = watch(path.dirname(file), (_ev, name) => {
    if (name !== path.basename(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        cb(loadConfig(file));
      } catch (e) {
        onError(e as Error);
      }
    }, 300);
  });
  return () => {
    if (timer) clearTimeout(timer);
    w.close();
  };
}
