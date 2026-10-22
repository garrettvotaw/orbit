#!/usr/bin/env node
// CLI entry point for /stack. Every subcommand is a pure function of what is on disk, so it behaves identically on
// day 3 of a new session and minute 5 of this one.
//
// Usage:
//   node stack.js registry
//   node stack.js register   --feature <name> --story <id> --worktree <path> --branch <integration> [--repo <root>]
//                            [--base <branch>] [--slices a,b,c]
//   node stack.js unregister --feature <name>
//   node stack.js status     [--feature <name>] [--offline]
//   node stack.js plan       --feature <name> [--write]
//   node stack.js cut        --feature <name> [--slice <id>[,<id>]]
//   node stack.js union      --feature <name>
//   node stack.js gate       --feature <name>
//   node stack.js hash       --feature <name>
//   node stack.js body       --feature <name> --slice <id>
//   node stack.js demo       --feature <name> --steps "step one|step two" [--force]
import { execFileSync } from 'node:child_process';
import * as demo from './demo.js';
import * as gate from './gate.js';
import * as man from './manifest.js';
import * as mat from './materialize.js';
import * as plan from './plan.js';
import { branchPrefix, loadProfile, stackConfig, storyLink, verifyCommandFor } from './profile.js';
import * as rec from './reconcile.js';
import * as st from './state.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function requireStack(args) {
  const reg = st.readRegistry();
  if (!reg.stacks.length) die(`no active stacks in ${st.registryPath()}`);
  const entry = args.feature ? reg.stacks.find((s) => s.feature === args.feature) : reg.stacks[reg.stacks.length - 1];
  if (!entry) die(`no stack named "${args.feature}"`);
  const state = st.readState(entry.worktree);
  if (!state) die(`no .stack/state.json in ${entry.worktree}`);
  const repo = state.repoRoot || entry.repoRoot || process.cwd();
  const profile = loadProfile(repo);
  const base = args.base || state.baseBranch || profile.baseBranch || 'main';
  return { entry, state, manifest: st.readManifest(entry.worktree), repo, profile, cfg: stackConfig(profile), base };
}

/** The owner and repo name: from the registry entry, else what gh sees in the repo. */
function ownerAndRepo(entry, repo) {
  if (entry.owner && entry.repo) return [entry.owner, entry.repo];
  const nwo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: repo,
    stdio: 'pipe',
  })
    .toString()
    .trim();
  return nwo.split('/');
}

// ---------------------------------------------------------------------------

function cmdRegister(args) {
  if (!args.feature || !args.worktree || !args.branch) die('register needs --feature, --worktree and --branch');
  const repoRoot = args.repo || mat.git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const profile = loadProfile(repoRoot);
  const baseBranch = args.base || profile.baseBranch || 'main';
  const entry = {
    feature: args.feature,
    story: args.story || null,
    worktree: args.worktree,
    integrationBranch: args.branch,
    repoRoot,
    createdAt: new Date().toISOString(),
  };
  st.registerStack(entry);
  const sliceIds = args.slices ? String(args.slices).split(',') : [];
  st.writeState(args.worktree, st.newState({ ...entry, baseBranch, sliceIds }));
  out({ registered: entry, registry: st.registryPath() });
}

function cmdUnregister(args) {
  if (!args.feature) die('unregister needs --feature');
  out(st.unregisterStack(args.feature));
}

function planReport(ctx, files, manifest, reconciled) {
  const invariants = man.checkInvariants(files, manifest);
  const bases = man.resolveBases(manifest, ctx.base);
  let order;
  try {
    order = man.topoOrder(manifest);
  } catch (e) {
    order = { error: String(e.message) };
  }
  return {
    feature: ctx.state.feature,
    changedFileCount: files.length,
    slices: manifest.slices.map((s) => ({
      id: s.id,
      title: s.title,
      needs: s.needs,
      base: bases[s.id],
      owns: s.owns.length > 12 ? [...s.owns.slice(0, 12), `... ${s.owns.length - 12} more`] : s.owns,
      fileCount: files.filter((f) => man.ownerOf(f, manifest) === s.id).length,
    })),
    order,
    spine: manifest.spine,
    drift: reconciled.drift,
    invariants,
    spineConflicts: man.spineConflicts(manifest),
    unresolvedSpineKeys: man.unassignedSpineKeys(manifest),
    unmapped: manifest.unmapped || [],
    parallelRoots: manifest.slices.filter((s) => !(s.needs || []).length).map((s) => s.id),
  };
}

function cmdPlan(args) {
  const ctx = requireStack(args);
  const integration = ctx.state.integrationBranch;
  const files = mat.changedFiles(ctx.repo, ctx.base, integration);
  if (!files.length) die(`no changes between ${ctx.base} and ${integration}`);

  const graph = plan.loadGraph(ctx.repo, ctx.cfg.graph);
  const proposal = plan.proposeSlices(files, graph, ctx.cfg, {
    feature: ctx.state.feature,
    story: ctx.state.story,
    storyLink: storyLink(ctx.profile, ctx.state.story),
    storyRef: storyLink(ctx.profile, ctx.state.story, { closes: false }),
    integration,
  });
  const spineFiles = Object.keys(proposal.spine);
  plan.collectSpineKeys(proposal, mat.collectSpineChangedKeys(ctx.repo, ctx.base, integration, spineFiles));

  const reconciled = plan.reconcileWithSketch(proposal, ctx.manifest || {});
  const manifest = reconciled.manifest;
  const report = planReport(ctx, files, manifest, reconciled);

  if (args.write) {
    if (!report.invariants.ok) die('refusing to write manifest: invariants failed');
    if (report.unresolvedSpineKeys.length) die('refusing to write manifest: unassigned spine keys');
    delete manifest.unmapped;
    st.writeManifest(ctx.entry.worktree, manifest);
    st.syncSlices(ctx.state, manifest);
    st.writeState(ctx.entry.worktree, ctx.state);
    report.written = st.manifestPath(ctx.entry.worktree);
  }
  out(report);
}

/** Cut one slice unless its content is unchanged or it was not asked for. Returns the result row. */
function cutOne(ctx, wt, id, i, order, bases, branchOf, only) {
  const slice = ctx.manifest.slices.find((s) => s.id === id);
  const existing = ctx.state.slices[id] || {};
  // A branch already recorded in state wins, so a re-cut keeps pushing to the same branch.
  const branch = existing.branch || mat.branchNameFor(branchPrefix(ctx.profile), ctx.state.feature, i + 1, id);
  branchOf[id] = branch;
  const parent = bases[id];
  const baseRef = parent === ctx.base ? ctx.base : branchOf[parent] || ctx.base;

  const newHash = mat.contentHashOf(ctx.repo, ctx.state.integrationBranch, slice.owns || []);
  const branchExists = mat.gitTry(ctx.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  if (only && !only.includes(id)) return { slice: id, branch, skipped: 'not requested' };
  if (branchExists && existing.contentHash === newHash) return { slice: id, branch, skipped: 'unchanged' };

  const r = mat.cutSlice({
    cutWorktree: wt,
    manifest: ctx.manifest,
    sliceId: id,
    integrationRef: ctx.state.integrationBranch,
    baseRef,
    branchName: branch,
  });
  const s = ctx.state.slices[id] || st.defaultSlice(id, ctx.base);
  Object.assign(s, { branch, base: baseRef, contentHash: newHash });
  if (s.status === 'pending') s.status = 'verified';
  ctx.state.slices[id] = s;
  return { ...r, base: baseRef, contentHash: newHash };
}

function cmdCut(args) {
  const ctx = requireStack(args);
  if (!ctx.manifest) die('no manifest, run plan --write first');
  const integration = ctx.state.integrationBranch;
  const invariants = man.checkInvariants(mat.changedFiles(ctx.repo, ctx.base, integration), ctx.manifest);
  if (!invariants.ok) return out({ error: 'invariants failed', invariants });

  const order = man.topoOrder(ctx.manifest);
  const bases = man.resolveBases(ctx.manifest, ctx.base);
  const wt = mat.ensureCutWorktree(ctx.repo, ctx.state.feature, integration, ctx.cfg.cutRoot);
  const only = args.slice ? String(args.slice).split(',') : null;
  const branchOf = {};
  const results = order.map((id, i) => cutOne(ctx, wt, id, i, order, bases, branchOf, only));
  st.writeState(ctx.entry.worktree, ctx.state);

  const union = mat.assertUnion(ctx.repo, ctx.base, integration, Object.values(branchOf));
  const verify = order.map((id) => ({
    slice: id,
    branch: branchOf[id],
    command: verifyCommandFor(ctx.profile, bases[id] === ctx.base ? ctx.base : branchOf[bases[id]]),
  }));
  out({ cutWorktree: wt, results, union, verify });
}

function cmdUnion(args) {
  const ctx = requireStack(args);
  const branches = Object.values(ctx.state.slices)
    .map((s) => s.branch)
    .filter(Boolean);
  out(mat.assertUnion(ctx.repo, ctx.base, ctx.state.integrationBranch, branches));
}

function cmdHash(args) {
  const ctx = requireStack(args);
  const res = {};
  for (const s of (ctx.manifest || { slices: [] }).slices) {
    const current = mat.contentHashOf(ctx.repo, ctx.state.integrationBranch, s.owns || []);
    const stored = (ctx.state.slices[s.id] || {}).contentHash;
    res[s.id] = { stored, current, changed: stored !== current };
  }
  out(res);
}

function reconcileStack(entry, state, offline) {
  const prs = rec.prNumbersOf(state);
  if (!prs.length || offline) return [];
  try {
    const [owner, repo] = ownerAndRepo(entry, state.repoRoot || entry.repoRoot || process.cwd());
    const applied = rec.applyFacts(state, rec.fetchFacts(owner, repo, prs), new Date().toISOString());
    st.writeState(entry.worktree, state);
    return applied.deltas.map(rec.formatDelta);
  } catch (e) {
    return [`reconcile failed: ${String(e.message).split('\n')[0]}`];
  }
}

function statusFor(entry, offline) {
  const state = st.readState(entry.worktree);
  if (!state) return { feature: entry.feature, error: 'missing state.json' };
  const deltas = reconcileStack(entry, state, offline);
  const manifest = st.readManifest(entry.worktree);
  return {
    feature: state.feature,
    story: state.story,
    worktree: entry.worktree,
    integrationBranch: state.integrationBranch,
    lastReconciledAt: state.lastReconciledAt,
    deltas,
    slices: Object.entries(state.slices).map(([id, s]) => {
      const verdict = s.prNumber ? gate.evaluateGate(s) : null;
      return {
        id,
        status: s.status,
        pr: s.prNumber,
        branch: s.branch,
        base: s.base,
        approvedBy: s.approvedBy,
        checks: s.checksStatus,
        threads: s.unresolvedThreads,
        mergeableNow: verdict ? verdict.mergeable : false,
        blocking: verdict && !verdict.mergeable ? verdict.reasons : [],
      };
    }),
    mergeableNow: rec.mergeableSlices(state),
    openable: manifest ? man.openableSlices(manifest, state) : [],
  };
}

function cmdStatus(args) {
  const reg = st.readRegistry();
  if (!reg.stacks.length) return out({ stacks: [] });
  const wanted = args.feature ? reg.stacks.filter((s) => s.feature === args.feature) : reg.stacks;
  out({ stacks: wanted.map((e) => statusFor(e, Boolean(args.offline))) });
}

function cmdGate(args) {
  const ctx = requireStack(args);
  const res = {};
  for (const [id, s] of Object.entries(ctx.state.slices)) {
    if (!s.prNumber) {
      res[id] = { pr: null, mergeable: false, why: ['no PR open'] };
      continue;
    }
    const v = gate.evaluateGate(s);
    res[id] = { pr: s.prNumber, mergeable: v.mergeable, why: gate.explain(v.reasons) };
  }
  out(res);
}

/** The PR body header for one slice: position, DAG, ownership, and the demo link. */
function cmdBody(args) {
  const ctx = requireStack(args);
  if (!ctx.manifest) die('no manifest, run plan --write first');
  const order = man.topoOrder(ctx.manifest);
  const slice = ctx.manifest.slices.find((s) => s.id === args.slice);
  if (!slice) die(`no slice "${args.slice}"`);
  const bases = man.resolveBases(ctx.manifest, ctx.base);
  const section = demo.prBodyStackSection({
    index: order.indexOf(slice.id) + 1,
    total: order.length,
    sliceId: slice.id,
    integrationBranch: ctx.state.integrationBranch,
    baseBranch: ctx.base,
    base: (ctx.state.slices[slice.id] || {}).base || bases[slice.id],
    needs: slice.needs,
    owns: slice.owns,
    dag: demo.renderDag(ctx.manifest, ctx.state),
  });
  // Only the top slice closes the story. Every other slice references it without a closing keyword.
  const closes = slice.id === man.topSlice(ctx.manifest);
  const link = ctx.state.story ? demo.prBodyDemoSection(storyLink(ctx.profile, ctx.state.story, { closes })) : '';
  process.stdout.write(`${section}\n${link}`);
}

function cmdDemo(args) {
  const ctx = requireStack(args);
  const steps = args.steps ? String(args.steps).split('|') : [];
  out(
    demo.writeDemoTemplate(ctx.entry.worktree, {
      feature: ctx.state.feature,
      story: storyLink(ctx.profile, ctx.state.story, { closes: false }),
      steps,
      force: Boolean(args.force),
    }),
  );
}

const CMDS = {
  registry: () => out(st.readRegistry()),
  register: cmdRegister,
  unregister: cmdUnregister,
  plan: cmdPlan,
  cut: cmdCut,
  union: cmdUnion,
  hash: cmdHash,
  status: cmdStatus,
  gate: cmdGate,
  body: cmdBody,
  demo: cmdDemo,
};

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || !CMDS[cmd]) die(`usage: stack.js <${Object.keys(CMDS).join('|')}> [--feature <name>]`);
try {
  CMDS[cmd](parseArgs(argv.slice(1)));
} catch (e) {
  die(`error: ${e.stack || e.message}`);
}
