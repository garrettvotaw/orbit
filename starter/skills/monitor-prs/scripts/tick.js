#!/usr/bin/env node
// Applies one update to the monitor's state.json from a patch file, so notes with quotes and apostrophes never pass
// through a shell. Write the patch with the Write tool, then run this.
//
//   node tick.js <stateFile> <patch.json>          # apply the patch
//   node tick.js <stateFile> <patch.json> --tick   # apply it and count a tick (once per tick, at the end)
//
// patch.json, every key optional:
//   {
//     "lanes": [{ "pr": 12, "bucket": "fixing", "owner": "fix-12-unit", "dispatchedAt": "now",
//                 "stages": { "ci": { "state": "bad", "label": "unit red" } } }],
//     "drop": [9],
//     "activity": ["#12 unit red, sonnet fixer on it"],
//     "repo": "owner/name"
//   }
//
// A lane's fields merge into the lane with the same pr (and the same repo, when either names one); each stage it
// names replaces that stage whole, so send its state and label together. A new pr adds a lane. "now" as
// dispatchedAt becomes the current time, and null clears a field. Activity entries get
// the current time and the list keeps its last 12. updatedAt is set on every write. The file is written to a temp
// file and renamed over, so Orbit never reads half of it.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const [stateFile, patchFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!stateFile || !patchFile) {
  console.error('usage: node tick.js <stateFile> <patch.json> [--tick]');
  process.exit(2);
}
const countTick = process.argv.includes('--tick');

const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const patch = JSON.parse(readFileSync(patchFile, 'utf8'));
const now = new Date().toISOString();

state.lanes ??= [];
state.activity ??= [];
if (patch.repo) state.repo = patch.repo;

const sameLane = (a, b) => a.pr === b.pr && (a.repo ?? state.repo) === (b.repo ?? state.repo);

for (const p of patch.lanes ?? []) {
  if (typeof p.pr !== 'number') {
    console.error(`skipped a lane with no numeric pr: ${JSON.stringify(p)}`);
    continue;
  }
  const update = { ...p };
  if (update.dispatchedAt === 'now') update.dispatchedAt = now;
  let lane = state.lanes.find((l) => sameLane(l, p));
  if (!lane) {
    lane = { pr: p.pr, stages: {} };
    state.lanes.push(lane);
  }
  const { stages, ...fields } = update;
  Object.assign(lane, fields);
  lane.stages = { ...(lane.stages ?? {}) };
  for (const [key, stage] of Object.entries(stages ?? {})) lane.stages[key] = stage;
}

const drop = new Set(patch.drop ?? []);
state.lanes = state.lanes.filter((l) => !drop.has(l.pr));

for (const text of patch.activity ?? []) state.activity.push({ at: now, text });
state.activity = state.activity.slice(-12);

state.updatedAt = now;
if (countTick) state.tick = (state.tick ?? 0) + 1;

const tmp = `${stateFile}.tmp`;
writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
for (let attempt = 1; ; attempt++) {
  try {
    renameSync(tmp, stateFile);
    break;
  } catch (e) {
    // On Windows a reader holding the file open makes the rename fail for a moment.
    if (attempt >= 5) throw e;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
console.log(`tick ${state.tick ?? 0}, ${state.lanes.length} lanes, updated ${now}`);
