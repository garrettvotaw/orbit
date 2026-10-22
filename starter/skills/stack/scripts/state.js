// Durable state for the /stack workflow.
//
// Nothing about a stack lives in conversation context. The registry is the stable entry point; each stack's real
// state lives beside the work, in the integration worktree under .stack/. A cold session reads these and knows
// everything.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STACK_DIR = '.stack';

export const registryDir = () => process.env.STACK_REGISTRY_DIR || path.join(os.homedir(), '.claude');
export const registryPath = () => path.join(registryDir(), 'stack-registry.json');

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, p);
}

export const readRegistry = () => readJson(registryPath(), { stacks: [] });
export const writeRegistry = (reg) => writeJsonAtomic(registryPath(), reg);

/** Keyed on `feature` and replaces in place, so it is safe to call repeatedly. */
export function registerStack(entry) {
  const reg = readRegistry();
  reg.stacks = reg.stacks.filter((s) => s.feature !== entry.feature);
  reg.stacks.push(entry);
  writeRegistry(reg);
  return reg;
}

export function unregisterStack(feature) {
  const reg = readRegistry();
  reg.stacks = reg.stacks.filter((s) => s.feature !== feature);
  writeRegistry(reg);
  return reg;
}

export const findStack = (feature) => readRegistry().stacks.find((s) => s.feature === feature) || null;

export const statePath = (worktree) => path.join(worktree, STACK_DIR, 'state.json');
export const manifestPath = (worktree) => path.join(worktree, STACK_DIR, 'manifest.json');
export const readState = (worktree) => readJson(statePath(worktree), null);
export const writeState = (worktree, s) => writeJsonAtomic(statePath(worktree), s);
export const readManifest = (worktree) => readJson(manifestPath(worktree), null);
export const writeManifest = (worktree, m) => writeJsonAtomic(manifestPath(worktree), m);

/**
 * status values:
 *   pending  - no branch cut yet
 *   verified - branch cut and builds standalone, PR not opened
 *   open     - PR open, waiting on review or checks
 *   approved - gate passes; safe to merge
 *   merged   - merged to the base branch
 *   blocked  - something needs a human (see blockedReason)
 */
export function defaultSlice(id, baseBranch = 'main') {
  return {
    id,
    status: 'pending',
    prNumber: null,
    branch: null,
    base: baseBranch,
    state: null,
    headSha: null,
    approvedSha: null,
    approvedBy: null,
    reviewDecision: null,
    unresolvedThreads: 0,
    checksStatus: null,
    mergeable: null,
    contentHash: null,
    verifiedAt: null,
    blockedReason: null,
  };
}

export function newState(opts) {
  const slices = {};
  for (const id of opts.sliceIds || []) slices[id] = defaultSlice(id, opts.baseBranch);
  return {
    feature: opts.feature,
    story: opts.story || null,
    integrationBranch: opts.integrationBranch,
    worktree: opts.worktree,
    repoRoot: opts.repoRoot || null,
    baseBranch: opts.baseBranch || 'main',
    trackerStage: opts.trackerStage || null,
    lastReconciledAt: null,
    slices,
  };
}

/** Keep state.slices in step with the manifest without clobbering live PR data. */
export function syncSlices(state, manifest) {
  const ids = (manifest.slices || []).map((s) => s.id);
  for (const id of ids) if (!state.slices[id]) state.slices[id] = defaultSlice(id, state.baseBranch);
  for (const id of Object.keys(state.slices)) {
    // Never silently drop a slice that has a live PR.
    if (!ids.includes(id) && !state.slices[id].prNumber) delete state.slices[id];
  }
  return state;
}
