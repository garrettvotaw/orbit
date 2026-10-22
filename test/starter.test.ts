import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { boardTools, type BoardAccess } from '../src/main/board-tools.ts';
import { openDb } from '../src/main/db.ts';
import { decisionTools, DecisionStore } from '../src/main/decisions.ts';
import { boardTool, laneTools, reviewTool, type LaneSink } from '../src/main/lane-tools.ts';
import { STARTER } from '../src/main/starter.ts';
import { StoryStore, moonTools, pmStoryTools, type MoonHost } from '../src/main/stories.ts';

/**
 * Static checks on the orbit-starter plugin: every agent and skill it names must ship, every Orbit
 * tool it grants must exist, and nothing outside the plugin and its one declared dependency is
 * referenced by plugin prefix.
 */

const root = path.resolve(import.meta.dirname, '..', 'starter');
const PLUGIN = 'orbit-starter';
const ALLOWED_PREFIXES = new Set([PLUGIN, 'superpowers']);

interface Known {
  agents: Set<string>;
  skills: Set<string>;
  tools: Set<string>;
}

/** The tool names Orbit serves, read off the real factories the way the no-ADO test builds them. */
function orbitToolNames(): Set<string> {
  const sink = {} as LaneSink;
  const store = new StoryStore(openDb(':memory:'));
  const decisions = new DecisionStore(openDb(':memory:'));
  const access: BoardAccess = { tracker: () => null, board: () => null, refresh: async () => {} };
  const host = {} as MoonHost;
  const pm = { id: 'shop', name: 'Storefront', cwd: '.' };
  const opts = { cap: 2, model: null, agent: STARTER.storyAgent, skill: STARTER.storySkill };
  const tools = [
    ...laneTools(sink, { id: 'shop' }),
    boardTool(sink, { id: 'shop' }),
    reviewTool(sink, { id: 'shop' }),
    ...decisionTools(decisions, { id: 'shop', name: 'Storefront' }),
    ...boardTools(access, { projectId: 'shop' }),
    ...pmStoryTools(store, host, pm, opts),
    ...moonTools(store, host, { id: 'story-shop-45' }),
  ] as Array<{ name: string }>;
  return new Set(tools.map((t) => t.name));
}

function listNames(dir: string, pick: (entry: string) => string | null): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => pick(e) ?? []);
}

/** What the plugin actually ships right now: starter/agents/<n>.md and starter/skills/<n>/SKILL.md. */
function shipped(): Known {
  const agents = listNames(path.join(root, 'agents'), (e) => (e.endsWith('.md') ? e.slice(0, -3) : null));
  const skills = listNames(path.join(root, 'skills'), (e) =>
    existsSync(path.join(root, 'skills', e, 'SKILL.md')) ? e : null,
  );
  return { agents: new Set(agents), skills: new Set(skills), tools: orbitToolNames() };
}

function walk(dir: string, keep: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full, keep);
    return keep(full) ? [full] : [];
  });
}

const isStarterName = (name: string, k: Known) => k.agents.has(name) || k.skills.has(name);

/** A prefixed reference passes only if a shipped file backs it. */
function resolves(name: string, k: Known): boolean {
  return isStarterName(name, k);
}

/** `Agent(a, b)` grant entries, wherever they appear. */
function agentGrants(text: string): string[] {
  return [...text.matchAll(/\bAgent\(([^)]*)\)/g)].flatMap((m) =>
    m[1]
      .split(',')
      .map((s) => s.trim().replace(/^["'`]|["'`]$/g, ''))
      .filter(Boolean),
  );
}

/**
 * Values used as an agent or skill reference: a `subagent_type`/`agent`/`skill` key, or a
 * `Skill(...)` call. Only these positions count, so prose that mentions an architect or a debugger
 * is never read as a reference.
 */
function keyedRefs(text: string): string[] {
  const keyed = [...text.matchAll(/\b(?:subagent_type|agent|skill)["']?\s*[:=]\s*["'`]?([A-Za-z0-9:_-]+)/g)];
  const calls = [...text.matchAll(/\bSkill\(\s*["'`]?([A-Za-z0-9:_-]+)/g)];
  return [...keyed, ...calls].map((m) => m[1]);
}

/**
 * Backticked names that follow a dispatch verb ("dispatch `builder`", "spawn `debugger`") or sit in
 * "run the `x` agent|skill". Same sentence only.
 */
function phraseRefs(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(
      /\b(?:dispatch(?:es|ed|ing)?|spawn(?:s|ed|ing)?|invoke[sd]?|invoking)\b[^.\n]*?`([a-z][a-z0-9-]*)`/gi,
    ))
      out.push(m[1]);
    for (const m of line.matchAll(/\bruns?\s+the\s+`([a-z][a-z0-9-]*)`\s+(?:agent|skill)\b/gi)) out.push(m[1]);
    for (const m of line.matchAll(/\bruns?\s+the\s+[^.\n`]*?`([a-z][a-z0-9-]*)`\s+(?:agent|skill)\b/gi)) out.push(m[1]);
  }
  return out;
}

/** Every `plugin:name` pair that is plainly a plugin reference rather than prose or a URL. */
function prefixedRefs(text: string): Array<{ plugin: string; name: string }> {
  const found = new Map<string, { plugin: string; name: string }>();
  const add = (plugin: string, name: string) => found.set(`${plugin}:${name}`, { plugin, name });
  for (const m of text.matchAll(/\b(orbit-starter|superpowers):([a-z][a-z0-9-]*)/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/`([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)`/g)) add(m[1], m[2]);
  for (const v of [...keyedRefs(text), ...agentGrants(text)]) {
    const m = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/.exec(v);
    if (m) add(m[1], m[2]);
  }
  return [...found.values()];
}

/** Everything wrong with one file's references. */
export function checkText(file: string, text: string, k: Known): string[] {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(`${file}: ${msg}`);

  for (const { plugin, name } of prefixedRefs(text)) {
    if (!ALLOWED_PREFIXES.has(plugin))
      bad(`references ${plugin}:${name}, only ${[...ALLOWED_PREFIXES].join(' and ')} may be prefixed`);
    else if (plugin === PLUGIN && !resolves(name, k)) bad(`${PLUGIN}:${name} is not shipped`);
  }

  for (const entry of agentGrants(text)) {
    if (!entry.includes(':') && isStarterName(entry, k)) bad(`Agent() grants bare "${entry}", use ${PLUGIN}:${entry}`);
  }

  for (const v of [...keyedRefs(text), ...phraseRefs(text)]) {
    if (!v.includes(':') && isStarterName(v, k)) bad(`bare reference to "${v}", use ${PLUGIN}:${v}`);
  }

  for (const m of text.matchAll(/\bmcp__orbit__([a-z_]+)/g)) {
    const tool = m[1].replace(/_+$/, '');
    if (!k.tools.has(tool)) bad(`mcp__orbit__${tool} is not an Orbit tool`);
  }
  return problems;
}

/** `lanes[].agent` values in starter/examples/**\/repo.json. */
export function checkRepoJson(file: string, text: string, k: Known): string[] {
  const problems: string[] = [];
  const parsed = JSON.parse(text) as { lanes?: Array<{ agent?: unknown }> };
  for (const lane of parsed.lanes ?? []) {
    const agent = lane.agent;
    if (typeof agent !== 'string') continue;
    if (agent.startsWith(`${PLUGIN}:`)) {
      if (!resolves(agent.slice(PLUGIN.length + 1), k)) problems.push(`${file}: ${agent} is not shipped`);
    } else if (!agent.includes(':') && isStarterName(agent, k)) {
      problems.push(`${file}: bare agent "${agent}", use ${PLUGIN}:${agent}`);
    }
  }
  return problems;
}

const known = shipped();

test('the plugin and marketplace manifests name orbit-starter', () => {
  const plugin = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, PLUGIN);
  assert.deepEqual(
    plugin.dependencies.map((d: string | { name: string }) => (typeof d === 'string' ? d : d.name)),
    ['superpowers'],
  );
  const market = JSON.parse(readFileSync(path.join(root, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(market.name, 'orbit');
  assert.deepEqual(
    market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [[PLUGIN, './starter']],
  );
});

test('the names Orbit defaults to are the plugin names', () => {
  for (const v of Object.values(STARTER)) assert.match(v, new RegExp(`^${PLUGIN}:[a-z-]+$`));
});

test('Orbit tool names come from the real factories', () => {
  for (const t of ['needs_you', 'post_status', 'start_story', 'claim_files', 'list_board', 'review_preview'])
    assert.ok(known.tools.has(t), t);
});

test('every reference in starter/agents and starter/skills resolves', () => {
  const files = [
    ...walk(path.join(root, 'agents'), (f) => f.endsWith('.md')),
    ...walk(path.join(root, 'skills'), (f) => f.endsWith('.md')),
  ];
  const problems = files.flatMap((f) => checkText(path.relative(root, f), readFileSync(f, 'utf8'), known));
  assert.deepEqual(problems, []);
});

test('every lane agent in starter/examples repo.json resolves', () => {
  const files = walk(path.join(root, 'examples'), (f) => path.basename(f) === 'repo.json');
  const problems = files.flatMap((f) => checkRepoJson(path.relative(root, f), readFileSync(f, 'utf8'), known));
  assert.deepEqual(problems, []);
});

// The checker's own behaviour, on in-memory text, against a fixed set of shipped names.
const fixture: Known = {
  agents: new Set(['builder', 'architect', 'debugger', 'pm']),
  skills: new Set(['story-engine', 'ac-verify']),
  tools: known.tools,
};

test('checker accepts shipped and prefixed references', () => {
  const text = [
    '---',
    'tools: Read, Agent(orbit-starter:builder, orbit-starter:architect, Explore), Skill, mcp__orbit__needs_you, mcp__orbit',
    '---',
    'Run the `orbit-starter:story-engine` skill, then dispatch the superpowers:test-driven-development skill.',
    'Skill(orbit-starter:story-engine) and subagent_type: "orbit-starter:builder".',
  ].join('\n');
  assert.deepEqual(checkText('ok.md', text, fixture), []);
});

test('checker flags each kind of broken reference', () => {
  const cases: Array<[string, RegExp]> = [
    ['Use orbit-starter:ghost for this.', /orbit-starter:ghost is not shipped/],
    ['tools: Agent(builder)', /Agent\(\) grants bare "builder"/],
    ['subagent_type: "debugger"', /bare reference to "debugger"/],
    ['Skill(story-engine)', /bare reference to "story-engine"/],
    ['Then dispatch `architect` for the plan.', /bare reference to "architect"/],
    ['Run the `ac-verify` skill first.', /bare reference to "ac-verify"/],
    ['tools: mcp__orbit__made_up', /mcp__orbit__made_up is not an Orbit tool/],
    ['Call `other-plugin:thing` here.', /other-plugin:thing/],
    ['Agent(otherplugin:thing)', /otherplugin:thing/],
  ];
  for (const [text, expected] of cases) {
    const problems = checkText('bad.md', text, fixture);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${text} -> ${JSON.stringify(problems)}`,
    );
  }
});

test('checker leaves ordinary prose about roles alone', () => {
  const text = [
    'The architect owns the design and the debugger owns the failing build.',
    'A builder on the backend team and a frontend lead can both review. See the stack of PRs.',
    'Dispatch the work to whoever is free. Run the tests, then run the linter.',
    'The review-pr step is described below. Ask the user: which agent should take it?',
  ].join('\n');
  assert.deepEqual(checkText('prose.md', text, fixture), []);
});

test('repo.json checker flags bare and unknown starter lane agents', () => {
  const json = JSON.stringify({
    lanes: [{ agent: 'orbit-starter:pm' }, { agent: 'orbit-starter:ghost' }, { agent: 'builder' }, { agent: 'my-own' }],
  });
  const problems = checkRepoJson('repo.json', json, fixture);
  assert.equal(problems.length, 2, JSON.stringify(problems));
  assert.match(problems[0], /orbit-starter:ghost/);
  assert.match(problems[1], /bare agent "builder"/);
});

// ---- repo profile schema -------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: Json[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  default?: Json;
}

const typeOf = (v: Json): string =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'number' && Number.isInteger(v)
        ? 'integer'
        : typeof v;

/**
 * A validator for just the JSON Schema keywords repo.schema.json uses: type, properties, required,
 * enum, items, additionalProperties, oneOf, anyOf. `default` is documentation and is ignored. An
 * unknown keyword throws, so the schema can't quietly grow past what this checks.
 */
export function validate(schema: Schema, value: Json, at = '$'): string[] {
  const known = new Set([
    'type',
    'properties',
    'required',
    'enum',
    'items',
    'additionalProperties',
    'oneOf',
    'anyOf',
    'default',
    'description',
    '$schema',
    'title',
  ]);
  for (const k of Object.keys(schema)) if (!known.has(k)) throw new Error(`validator does not support "${k}"`);

  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!ok) return [`${at}: expected ${schema.type}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }
  const problems: string[] = [];
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, value, at).length === 0)) {
    problems.push(`${at}: matches none of the allowed shapes`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => validate(s, value, at).length === 0).length;
    if (matches !== 1) problems.push(`${at}: matches ${matches} of the oneOf shapes, expected exactly 1`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => problems.push(...validate(schema.items as Schema, v, `${at}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${at}: missing required "${key}"`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) problems.push(...validate(sub, v, `${at}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${at}: unexpected key "${key}"`);
      else if (typeof schema.additionalProperties === 'object') {
        problems.push(...validate(schema.additionalProperties, v, `${at}.${key}`));
      }
    }
  }
  return problems;
}

const schema = JSON.parse(readFileSync(path.join(root, 'schema', 'repo.schema.json'), 'utf8')) as Schema;
const minimalProfile = (): { [key: string]: Json } => ({
  baseBranch: 'main',
  branchTemplate: '{prefix}/{id}-{slug}',
  prefix: 'feat',
  worktree: { copy: [], link: [] },
  gates: { test: 'npm test' },
  lanes: [{ glob: '**', agent: 'orbit-starter:builder' }],
  consults: {},
});

test('every starter/examples repo.json validates against the schema', () => {
  const files = walk(path.join(root, 'examples'), (f) => path.basename(f) === 'repo.json');
  assert.equal(files.length, 2, 'both examples exist');
  for (const f of files) {
    assert.deepEqual(validate(schema, JSON.parse(readFileSync(f, 'utf8'))), [], path.relative(root, f));
  }
});

test('a profile with only the required keys validates; optional keys are optional', () => {
  assert.deepEqual(validate(schema, minimalProfile()), []);
});

test('the schema rejects bad profiles', () => {
  const cases: Array<[string, (p: { [key: string]: Json }) => void, RegExp]> = [
    ['merge: sometimes', (p) => (p.merge = 'sometimes'), /merge.*sometimes/],
    ['resolveThreads: always', (p) => (p.resolveThreads = 'always'), /resolveThreads/],
    ['missing gates.test', (p) => (p.gates = { lint: 'x' }), /missing required "test"/],
    ['missing lanes', (p) => delete p.lanes, /missing required "lanes"/],
    ['lane without agent', (p) => (p.lanes = [{ glob: '**' }]), /missing required "agent"/],
    ['maxOpenPrs as text', (p) => (p.maxOpenPrs = 'eight'), /maxOpenPrs/],
    ['ux of the wrong shape', (p) => (p.consults = { ux: 'yes' }), /consults\.ux/],
    ['unknown top-level key', (p) => (p.mege = 'ask'), /unexpected key "mege"/],
  ];
  for (const [name, mutate, expected] of cases) {
    const p = minimalProfile();
    mutate(p);
    const problems = validate(schema, p);
    assert.ok(
      problems.some((m) => expected.test(m)),
      `${name} -> ${JSON.stringify(problems)}`,
    );
  }
});

test('the schema accepts the optional keys when they are well formed', () => {
  const p = minimalProfile();
  Object.assign(p, {
    merge: 'auto',
    resolveThreads: 'never',
    maxOpenPrs: 4,
    serve: 'npm start',
    prLink: 'Closes #{id}',
    runbook: '.claude/orbit/runbook.md',
    worktree: { copy: ['.env'], link: ['node_modules'], install: 'npm ci' },
    gates: { test: 't', lint: 'l', format: 'f' },
    consults: { requirements: true, ux: { when: 'UI stories' }, integration: 'x', legacy: 'y', testData: false },
  });
  assert.deepEqual(validate(schema, p), []);
});
