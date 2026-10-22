import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentColorHex,
  agentColors,
  listAgents,
  listModels,
  mergeModels,
  modelsFromSettings,
  parseAgentFile,
} from '../src/main/catalog.ts';

test('parseAgentFile reads front matter and falls back to the file name', () => {
  assert.deepEqual(
    parseAgentFile('shop-pm.md', '---\nname: shop-pm\ndescription: "Runs the Shop board"\nmodel: opus\n---\nbody'),
    {
      name: 'shop-pm',
      description: 'Runs the Shop board',
      color: null,
    },
  );
  assert.deepEqual(parseAgentFile('plain.md', 'no front matter'), { name: 'plain', description: '', color: null });
});

test('parseAgentFile maps a declared color to hex and drops one it cannot read', () => {
  assert.equal(parseAgentFile('a.md', '---\nname: a\ncolor: cyan\n---\n').color, '#22d3ee');
  assert.equal(parseAgentFile('a.md', '---\nname: a\ncolor: "#ABCDEF"\n---\n').color, '#abcdef');
  assert.equal(parseAgentFile('a.md', '---\nname: a\ncolor: chartreuse\n---\n').color, null);
  assert.equal(agentColorHex('Purple'), '#c084fc');
});

test('agentColors collects declared colors across lane folders', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orbit-home-'));
  const a = mkdtempSync(path.join(tmpdir(), 'orbit-a-'));
  const b = mkdtempSync(path.join(tmpdir(), 'orbit-b-'));
  mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  mkdirSync(path.join(a, '.claude', 'agents'), { recursive: true });
  mkdirSync(path.join(b, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'agents', 'erp-api.md'), '---\nname: erp-api\ncolor: orange\n---\n');
  writeFileSync(path.join(home, '.claude', 'agents', 'plain.md'), '---\nname: plain\n---\n');
  writeFileSync(path.join(a, '.claude', 'agents', 'review-bloat.md'), '---\nname: review-bloat\ncolor: pink\n---\n');
  writeFileSync(path.join(b, '.claude', 'agents', 'erp-api.md'), '---\nname: erp-api\ncolor: blue\n---\n');
  assert.deepEqual(agentColors([a, b, a], home), { 'erp-api': '#60a5fa', 'review-bloat': '#f472b6' });
});

test('listAgents merges user and project agents, project winning', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'orbit-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'orbit-cwd-'));
  mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'agents', 'shop-pm.md'),
    '---\nname: shop-pm\ndescription: user copy\n---\n',
  );
  writeFileSync(path.join(home, '.claude', 'agents', 'angular.md'), '---\nname: angular\ndescription: ng\n---\n');
  writeFileSync(
    path.join(cwd, '.claude', 'agents', 'shop-pm.md'),
    '---\nname: shop-pm\ndescription: project copy\n---\n',
  );
  writeFileSync(path.join(cwd, '.claude', 'agents', 'notes.txt'), 'ignored');
  const agents = listAgents(cwd, home);
  assert.deepEqual(
    agents.map((a) => [a.name, a.source, a.description]),
    [
      ['angular', 'user', 'ng'],
      ['shop-pm', 'project', 'project copy'],
    ],
  );
  assert.deepEqual(listAgents(path.join(cwd, 'nope'), path.join(home, 'nope')), []);
});

test('modelsFromSettings picks the pinned model ids', () => {
  const list = modelsFromSettings(
    JSON.stringify({
      env: {
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'us.anthropic.claude-fable-5-1[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-5-5',
        AWS_REGION: 'us-east-1',
      },
    }),
  );
  assert.deepEqual(list, [
    { value: 'us.anthropic.claude-fable-5-1[1m]', label: 'us.anthropic.claude-fable-5-1[1m] (fable)' },
    { value: 'us.anthropic.claude-sonnet-5-5', label: 'us.anthropic.claude-sonnet-5-5 (sonnet)' },
  ]);
  assert.deepEqual(modelsFromSettings('{bad'), []);
});

test('listModels merges aliases, pins, live, and reported models without duplicates', () => {
  const settings = path.join(mkdtempSync(path.join(tmpdir(), 'orbit-settings-')), 'settings.json');
  writeFileSync(
    settings,
    JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-5-5' } }),
  );
  const list = listModels({
    settingsFile: settings,
    live: [{ value: 'opus', label: 'Opus (live)' }],
    seen: ['us.anthropic.claude-sonnet-5-5', 'x-model'],
  });
  const values = list.map((m) => m.value);
  assert.deepEqual(values, ['fable', 'opus', 'sonnet', 'haiku', 'us.anthropic.claude-sonnet-5-5', 'x-model']);
  assert.equal(list.find((m) => m.value === 'opus')!.label, 'opus (alias)', 'first occurrence wins');
  assert.deepEqual(mergeModels(null, undefined, []), []);
});

/** A temp home with plugins installed the way Claude Code records them, and a repo folder. */
function pluginHome(entries: Record<string, Array<{ scope: string; projectPath?: string; agents: string[] }>>) {
  const home = mkdtempSync(path.join(tmpdir(), 'orbit-plugins-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'orbit-repo-'));
  const plugins: Record<string, unknown[]> = {};
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  for (const [key, installs] of Object.entries(entries)) {
    plugins[key] = installs.map((i, n) => {
      const installPath = path.join(home, '.claude', 'plugins', 'cache', key.replace('@', '-'), String(n));
      mkdirSync(path.join(installPath, 'agents'), { recursive: true });
      for (const a of i.agents)
        writeFileSync(
          path.join(installPath, 'agents', `${a}.md`),
          `---\nname: ${a}\ndescription: ${a} from ${n}\n---\n`,
        );
      return { scope: i.scope, ...(i.projectPath ? { projectPath: i.projectPath } : {}), installPath };
    });
  }
  writeFileSync(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }),
  );
  return { home, repo };
}

test("listAgents names a user-scoped plugin's agents plugin:agent", () => {
  const { home, repo } = pluginHome({ 'orbit-starter@orbit': [{ scope: 'user', agents: ['story-manager'] }] });
  const agents = listAgents(repo, home);
  assert.deepEqual(
    agents.map((a) => [a.name, a.source]),
    [['orbit-starter:story-manager', 'plugin']],
  );
});

test('listAgents lists a project-scoped plugin only for its folder, and prefers it over the user install', () => {
  const other = mkdtempSync(path.join(tmpdir(), 'orbit-other-'));
  const { home, repo } = pluginHome({});
  const both = pluginHome({
    'kit@market': [
      { scope: 'user', agents: ['helper'] },
      { scope: 'project', projectPath: repo, agents: ['helper', 'deployer'] },
    ],
    'solo@market': [{ scope: 'project', projectPath: repo, agents: ['tester'] }],
  });
  const names = (cwd: string) => listAgents(cwd, both.home).map((a) => a.name);
  assert.deepEqual(names(repo), ['kit:deployer', 'kit:helper', 'solo:tester']);
  assert.equal(
    listAgents(repo, both.home).find((a) => a.name === 'kit:helper')?.description,
    'helper from 1',
    'the project install wins',
  );
  assert.deepEqual(names(other), ['kit:helper']);
  if (process.platform === 'win32')
    assert.deepEqual(names(repo.toUpperCase()), names(repo), 'Windows paths ignore case');
  assert.deepEqual(listAgents(repo, home), []);
});

test('listAgents lists nothing for a plugin turned off in settings, and nothing extra for a broken manifest', () => {
  const { home, repo } = pluginHome({
    'kit@market': [{ scope: 'user', agents: ['helper'] }],
    'off@market': [{ scope: 'user', agents: ['idle'] }],
  });
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'off@market': false, 'kit@market': true } }),
  );
  assert.deepEqual(
    listAgents(repo, home).map((a) => a.name),
    ['kit:helper'],
  );
  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(
    path.join(repo, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'kit@market': false } }),
  );
  assert.deepEqual(listAgents(repo, home), [], "the folder's settings turn it off there");
  writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), '{ not json');
  mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'agents', 'mine.md'), '---\nname: mine\n---\n');
  assert.deepEqual(
    listAgents(repo, home).map((a) => [a.name, a.source]),
    [['mine', 'user']],
  );
});
