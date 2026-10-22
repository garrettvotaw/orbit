// Cuts slice branches out of the integration branch.
//
// Two rules shape everything here:
//
// 1. Never touch the integration worktree. The dev server runs there all day, which is the whole point of the
//    workflow. All branch checkouts happen in a dedicated cutting worktree.
//
// 2. Forward-only, never force-push. Re-materializing a slice adds a commit rather than rewriting history. Because
//    slices are whole-file checkouts, the resulting diff against the base is identical either way, so there is no
//    reason to rewrite, and not rewriting keeps reviewer inline comments live.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as man from './manifest.js';
import * as spine from './spine.js';

export function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 }).toString();
}

export function gitTry(repo, args) {
  try {
    return { ok: true, out: git(repo, args) };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message) };
  }
}

const lines = (out) =>
  out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

export const changedFiles = (repo, base, head) => lines(git(repo, ['diff', '--name-only', `${base}...${head}`]));

function lsTree(repo, ref) {
  return lines(git(repo, ['ls-tree', '-r', ref]))
    .map((line) => /^\d+\s+\w+\s+([0-9a-f]+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ sha: m[1], path: m[2] }));
}

/**
 * Hash of the owned content at a ref. Used to tell whether a re-materialize would actually change anything, so
 * /stack fix only touches affected slices.
 */
export function contentHashOf(repo, ref, patterns) {
  const entries = lsTree(repo, ref)
    .filter((e) => (patterns || []).some((p) => man.matchesPattern(e.path, p)))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const h = createHash('sha256');
  for (const e of entries) h.update(`${e.path}\0${e.sha}\n`);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Cutting worktree: an isolated checkout so the integration worktree's running dev server is never disturbed.
// ---------------------------------------------------------------------------

/** `cutRoot` from the profile, else a `.stack-cut` folder beside the repo. */
export function cutWorktreePath(repoRoot, feature, cutRoot) {
  const root = process.env.STACK_CUT_ROOT || cutRoot || path.join(path.dirname(path.resolve(repoRoot)), '.stack-cut');
  return path.join(root, feature);
}

export function ensureCutWorktree(repoRoot, feature, integrationBranch, cutRoot) {
  const wt = cutWorktreePath(repoRoot, feature, cutRoot);
  if (existsSync(path.join(wt, '.git'))) {
    gitTry(wt, ['fetch', 'origin', '--quiet']);
    return wt;
  }
  mkdirSync(path.dirname(wt), { recursive: true });
  // Detached so it never holds a branch another worktree wants.
  const r = gitTry(repoRoot, ['worktree', 'add', '--detach', wt, integrationBranch]);
  if (!r.ok) throw new Error(`could not create cutting worktree: ${r.out}`);
  return wt;
}

export function removeCutWorktree(repoRoot, feature, cutRoot) {
  gitTry(repoRoot, ['worktree', 'remove', '--force', cutWorktreePath(repoRoot, feature, cutRoot)]);
  gitTry(repoRoot, ['worktree', 'prune']);
}

// ---------------------------------------------------------------------------
// Spine handling
// ---------------------------------------------------------------------------

const spineKeysFor = (manifest, file, sliceId) =>
  Object.entries((manifest.spine || {})[file] || {})
    .filter(([, owner]) => owner === sliceId)
    .map(([key]) => key);

function showJson(repo, ref, file) {
  const r = gitTry(repo, ['show', `${ref}:${file}`]);
  if (!r.ok) return {};
  try {
    return JSON.parse(r.out);
  } catch {
    return {};
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function diffKeys(x, y, prefix, keys) {
  for (const k of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
    const at = prefix ? `${prefix}.${k}` : k;
    const [va, vb] = [(x || {})[k], (y || {})[k]];
    if (isObj(va) && isObj(vb)) diffKeys(va, vb, at, keys);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) keys.push(at);
  }
  return keys;
}

/** Which dotted keys actually differ between base and integration, so /stack plan can enumerate them to assign. */
export const jsonSpineChangedKeys = (repo, base, integrationRef, file) =>
  diffKeys(showJson(repo, base, file), showJson(repo, integrationRef, file), '', []);

function barrelSpineChangedLines(repo, base, integrationRef, file) {
  const read = (ref) => {
    const r = gitTry(repo, ['show', `${ref}:${file}`]);
    return r.ok ? r.out.split('\n').filter(Boolean) : [];
  };
  const before = read(base);
  return read(integrationRef).filter((l) => !before.includes(l));
}

export function collectSpineChangedKeys(repo, base, integrationRef, spineFiles) {
  const out = {};
  for (const file of spineFiles || []) {
    out[file] = spine.isJsonSpine(file)
      ? jsonSpineChangedKeys(repo, base, integrationRef, file)
      : barrelSpineChangedLines(repo, base, integrationRef, file);
  }
  return out;
}

function applySpine(wt, manifest, sliceId, integrationRef) {
  for (const file of Object.keys(manifest.spine || {})) {
    const keys = spineKeysFor(manifest, file, sliceId);
    if (!keys.length) continue;
    const abs = path.join(wt, file);
    const json = spine.isJsonSpine(file);
    const baseText = existsSync(abs) ? readFileSync(abs, 'utf8') : json ? '{}\n' : '';
    const show = gitTry(wt, ['show', `${integrationRef}:${file}`]);
    if (!show.ok) continue;
    const merged = json
      ? spine.mergeJsonSpine(baseText, show.out, keys)
      : spine.mergeBarrelSpine(baseText, show.out, keys);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, merged);
    gitTry(wt, ['add', '--', file]);
  }
}

// ---------------------------------------------------------------------------
// Slice cutting
// ---------------------------------------------------------------------------

export const branchNameFor = (prefix, feature, index, sliceId) => `${prefix}/${feature}/${index}-${sliceId}`;

const sliceById = (manifest, id) => (manifest.slices || []).find((s) => s.id === id);

function checkoutSliceBranch(wt, branchName, baseRef) {
  const exists = gitTry(wt, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]).ok;
  const args = exists
    ? ['checkout', '-q', '--force', branchName]
    : ['checkout', '-q', '--force', '-b', branchName, baseRef];
  const r = gitTry(wt, args);
  if (!r.ok) throw new Error(`${exists ? 'checkout' : 'branch create'} failed for ${branchName}: ${r.out}`);
  return exists;
}

/** Cut or forward-update one slice branch inside the cutting worktree. */
export function cutSlice(opts) {
  const wt = opts.cutWorktree;
  const manifest = opts.manifest;
  const s = sliceById(manifest, opts.sliceId);
  if (!s) throw new Error(`unknown slice: ${opts.sliceId}`);

  const exists = checkoutSliceBranch(wt, opts.branchName, opts.baseRef);

  // Clear anything left from a previous slice in this worktree.
  gitTry(wt, ['reset', '-q', '--hard', 'HEAD']);
  gitTry(wt, ['clean', '-qfd']);

  // Owned files: take integration's version wholesale.
  for (const pattern of s.owns || []) {
    const pathspec = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    gitTry(wt, ['checkout', opts.integrationRef, '--', pathspec]);
  }
  applySpine(wt, manifest, opts.sliceId, opts.integrationRef);
  gitTry(wt, ['add', '-A']);

  let committed = false;
  if (git(wt, ['status', '--porcelain']).trim()) {
    const msg = s.title || `${manifest.feature}: ${opts.sliceId}`;
    const args = ['commit', '-q', '-m', msg, ...(exists ? ['-m', 'refresh slice from integration branch'] : [])];
    const c = gitTry(wt, args);
    if (!c.ok) throw new Error(`commit failed for ${opts.branchName}: ${c.out}`);
    committed = true;
  }
  return {
    slice: opts.sliceId,
    branch: opts.branchName,
    created: !exists,
    committed,
    headSha: git(wt, ['rev-parse', 'HEAD']).trim(),
  };
}

/**
 * Completeness check: the slices together must reproduce the integration diff exactly. A file in `missing` means
 * nobody owns it.
 */
export function assertUnion(repo, base, integrationRef, sliceBranches) {
  const target = changedFiles(repo, base, integrationRef).filter((f) => !man.isIgnored(f));
  const union = new Set();
  // A branch that doesn't exist yet is a slice nobody has cut, which is normal when only part of the set is built.
  // It weakens nothing: files that slice owns are absent from the union and surface in `missing`.
  const uncut = [];
  for (const b of sliceBranches || []) {
    if (!gitTry(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).ok) {
      uncut.push(b);
      continue;
    }
    for (const f of changedFiles(repo, base, b)) union.add(f);
  }
  const missing = target.filter((f) => !union.has(f));
  const extra = [...union].filter((f) => !target.includes(f));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, uncut, targetCount: target.length };
}

/** Plain push, no lease games: forward-only means fast-forward always works. */
export const pushSlice = (wt, branchName) => gitTry(wt, ['push', '-u', 'origin', branchName]);
