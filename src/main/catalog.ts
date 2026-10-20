import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentOption, ModelOption } from '../shared/types.ts';

/** The named colors a Claude Code agent file may declare, as they read on Orbit's dark stage. */
const NAMED_COLORS: Record<string, string> = {
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#4ade80',
  cyan: '#22d3ee',
  blue: '#60a5fa',
  purple: '#c084fc',
  pink: '#f472b6',
};

export function agentColorHex(declared: string): string | null {
  const v = declared.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  return NAMED_COLORS[v] ?? null;
}

/** Pull `name`, `description`, and `color` out of a Claude Code agent file's front matter. */
export function parseAgentFile(fileName: string, text: string): Omit<AgentOption, 'source'> {
  const fallback = path.basename(fileName, '.md');
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: fallback, description: '', color: null };
  const field = (key: string) => {
    const line = m[1].split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${key}:`));
    return line
      ? line
          .slice(key.length + 1)
          .trim()
          .replace(/^["']|["']$/g, '')
      : '';
  };
  const color = field('color');
  return {
    name: field('name') || fallback,
    description: field('description'),
    color: color ? agentColorHex(color) : null,
  };
}

function readAgentsDir(dir: string, source: AgentOption['source']): AgentOption[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ ...parseAgentFile(f, readFileSync(path.join(dir, f), 'utf8')), source }));
}

/** Agents the CLI would see for a lane: the user's plus the project's, project winning on a name clash. */
export function listAgents(cwd: string, home = homedir()): AgentOption[] {
  const byName = new Map<string, AgentOption>();
  for (const a of readAgentsDir(path.join(home, '.claude', 'agents'), 'user')) byName.set(a.name, a);
  for (const a of readAgentsDir(path.join(cwd, '.claude', 'agents'), 'project')) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Declared agent colors across every lane folder, by agent name. Later folders win a clash. */
export function agentColors(cwds: string[], home = homedir()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cwd of [...new Set(cwds)]) {
    for (const a of listAgents(cwd, home)) if (a.color) out[a.name] = a.color;
  }
  return out;
}

const ALIASES: ModelOption[] = [
  { value: 'fable', label: 'fable (alias)' },
  { value: 'opus', label: 'opus (alias)' },
  { value: 'sonnet', label: 'sonnet (alias)' },
  { value: 'haiku', label: 'haiku (alias)' },
];

/** Model ids pinned in the user's Claude settings env block, such as ANTHROPIC_DEFAULT_SONNET_MODEL. */
export function modelsFromSettings(settingsJson: string): ModelOption[] {
  try {
    const env = (JSON.parse(settingsJson) as { env?: Record<string, string> }).env ?? {};
    return Object.entries(env)
      .filter(([k, v]) => /^ANTHROPIC_(DEFAULT_[A-Z]+_MODEL|MODEL)$/.test(k) && v)
      .map(([k, v]) => ({
        value: v,
        label: `${v} (${k
          .replace(/^ANTHROPIC_(DEFAULT_)?/, '')
          .replace(/_MODEL$/, '')
          .toLowerCase()})`,
      }));
  } catch {
    return [];
  }
}

/** One de-duplicated picker list: aliases, settings pins, what live sessions advertise, and what lanes report. */
export function mergeModels(...lists: Array<ModelOption[] | null | undefined>): ModelOption[] {
  const seen = new Map<string, ModelOption>();
  for (const list of lists) for (const m of list ?? []) if (m.value && !seen.has(m.value)) seen.set(m.value, m);
  return [...seen.values()];
}

export function listModels(
  opts: { settingsFile?: string; live?: ModelOption[] | null; seen?: string[] } = {},
): ModelOption[] {
  const settingsFile = opts.settingsFile ?? path.join(homedir(), '.claude', 'settings.json');
  const pinned = existsSync(settingsFile) ? modelsFromSettings(readFileSync(settingsFile, 'utf8')) : [];
  const reported = (opts.seen ?? []).map((v) => ({ value: v, label: v }));
  return mergeModels(ALIASES, pinned, opts.live, reported);
}
