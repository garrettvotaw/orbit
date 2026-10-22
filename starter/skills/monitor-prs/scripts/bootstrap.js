#!/usr/bin/env node
// Finds the monitor's state file and seeds it. Idempotent: safe to re-run on resume.
//
//   node bootstrap.js                    # resolve the state file, seed it if absent, say whether this is a resume
//   node bootstrap.js --state <path>     # use this state file
//   node bootstrap.js --repo owner/name  # record this repo instead of the one gh sees in the current folder
//
// Under Orbit (ORBIT_LANE is set) the state file is the `stateFile` Orbit's config gives this monitor lane, so the
// PR view Orbit draws reads the file this monitor writes. Outside Orbit it defaults to
// ~/.claude/reports/monitor-prs/state.json. Either way it lives outside the repo. It never polls PRs: the skill
// does that and writes the lanes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const expandHome = (p) => (p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);
const warnings = [];

/** The stateFile Orbit's config gives the lane this session runs in, or null outside Orbit or with no match. */
function orbitStateFile() {
  const lane = process.env.ORBIT_LANE;
  if (!lane) return null;
  const configFile = process.env.ORBIT_CONFIG ?? path.join(homedir(), '.claude', 'orbit', 'config.json');
  try {
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    const monitor = (cfg.monitors ?? []).find((m) => m.id === lane);
    if (monitor?.stateFile) return { file: expandHome(monitor.stateFile), from: `${configFile}, monitor "${lane}"` };
    warnings.push(`ORBIT_LANE is "${lane}" but ${configFile} has no monitor with that id and a stateFile.`);
  } catch (e) {
    warnings.push(`ORBIT_LANE is "${lane}" but Orbit's config could not be read: ${e.message}`);
  }
  return null;
}

function ghRepo() {
  try {
    return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    warnings.push(`gh repo view failed here, so no repo is recorded: ${String(e.stderr || e.message).trim()}`);
    return null;
  }
}

const explicit = arg('--state');
const orbit = explicit ? null : orbitStateFile();
const stateFile = explicit
  ? path.resolve(expandHome(explicit))
  : (orbit?.file ?? path.join(homedir(), '.claude', 'reports', 'monitor-prs', 'state.json'));
const from = explicit ? '--state' : (orbit?.from ?? 'default');
if (!explicit && !orbit && process.env.ORBIT_LANE) {
  warnings.push(`Using the default. Orbit's PR view reads only the stateFile its config names, so point it here.`);
}

const workDir = path.dirname(stateFile);
mkdirSync(workDir, { recursive: true });

const resuming = existsSync(stateFile);
let state;
if (resuming) {
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (e) {
    console.error(`${stateFile} is not valid JSON (${e.message}). Fix or move it, then run this again.`);
    process.exit(1);
  }
}
const repo = arg('--repo') ?? state?.repo ?? ghRepo();

if (!resuming) {
  state = { updatedAt: null, tick: 0, repo, activity: [], lanes: [] };
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
} else if (!state.repo && repo) {
  state.repo = repo;
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

console.log(JSON.stringify({ stateFile, workDir, from, resuming, repo }, null, 2));
for (const w of warnings) console.log(`WARNING: ${w}`);
if (resuming) {
  console.log(
    `\nRESUMING: last tick ${state.tick ?? 0} at ${state.updatedAt ?? 'never'}, ${(state.lanes ?? []).length} lanes.` +
      `\nRe-poll everything live before trusting any of it.`,
  );
}
