// Derives a slice PROPOSAL from the integration diff, the profile's layers, and (when the profile names one) the
// project graph.
//
// This is a guess, not an answer. The layers say which part of the codebase a changed file belongs to and in what
// order slices should land; the graph, when there is one, says which projects depend on which. That is enough for
// a sensible opening DAG. The build in materialize.js is what actually proves it: a slice that won't compile
// standalone means something it needs was assigned downstream, and the manifest is wrong.
import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as man from './manifest.js';

const norm = man.norm;
const OTHER = 'other';

/**
 * The graph, normalized to { nodes: { name: { root } }, dependencies: { name: [name] } }. `spec` is "nx" for the
 * built-in adapter, or a shell command that prints that shape as JSON. Returns null when there is no spec.
 */
export function loadGraph(repoRoot, spec) {
  if (!spec) return null;
  const opts = { cwd: repoRoot, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 };
  if (spec !== 'nx') return normalizeGraph(JSON.parse(execSync(spec, opts).toString()));
  const out = path.join(os.tmpdir(), `stack-graph-${process.pid}.json`);
  execSync(`npx nx graph --file="${out}"`, opts);
  const g = JSON.parse(readFileSync(out, 'utf8')).graph;
  try {
    unlinkSync(out);
  } catch {
    /* best effort */
  }
  const nodes = {};
  for (const [name, n] of Object.entries(g.nodes)) nodes[name] = { root: (n.data || {}).root };
  const dependencies = {};
  for (const [name, list] of Object.entries(g.dependencies || {})) dependencies[name] = list.map((d) => d.target);
  return { nodes, dependencies };
}

function normalizeGraph(raw) {
  const nodes = {};
  for (const [name, n] of Object.entries(raw.nodes || {})) nodes[name] = { root: n.root || (n.data || {}).root };
  const dependencies = {};
  for (const [name, list] of Object.entries(raw.dependencies || {})) {
    dependencies[name] = list.map((d) => (typeof d === 'string' ? d : d.target));
  }
  return { nodes, dependencies };
}

/** Longest matching project root wins, so a nested project beats its parent. */
export function projectForFile(file, nodes) {
  const f = norm(file);
  let best = null;
  let bestLen = -1;
  for (const [name, n] of Object.entries(nodes)) {
    const root = norm(n.root || '');
    if (!root) continue;
    if ((f === root || f.startsWith(`${root}/`)) && root.length > bestLen) {
      best = name;
      bestLen = root.length;
    }
  }
  return best;
}

/** The first layer whose paths match wins. Anything no layer claims lands in "other". */
export function layerOf(target, layers) {
  const hit = (layers || []).find((l) => (l.paths || []).some((p) => man.matchesPattern(target, p)));
  return hit ? hit.id : OTHER;
}

export const isSpine = (file, spineList) => (spineList || []).some((p) => man.matchesPattern(file, p));

/** Guess which slice a spine key belongs to from the alias or export text itself. */
export function guessSpineOwner(key, slices) {
  const k = String(key).toLowerCase();
  let hit = null;
  for (const s of slices) {
    for (const pattern of s.owns || []) {
      const leaf = norm(pattern).replace('/**', '').split('/').pop().toLowerCase();
      const trimmed = leaf.includes('-') ? leaf.slice(leaf.indexOf('-') + 1) : leaf;
      if ((leaf && k.includes(leaf)) || (trimmed && k.includes(trimmed))) hit = s.id;
    }
  }
  return hit;
}

function addTo(map, key, value) {
  if (!map[key]) map[key] = new Set();
  map[key].add(value);
}

/** Sort changed files into spine, unmapped, and a per-layer owns and project set. */
function classifyFiles(files, graph, cfg) {
  const owns = {};
  const projs = {};
  const unmapped = [];
  const spineFiles = [];
  for (const f of files.filter((x) => !man.isIgnored(x))) {
    if (isSpine(f, cfg.spine)) {
      spineFiles.push(norm(f));
      continue;
    }
    if (!graph) {
      addTo(owns, layerOf(f, cfg.layers), norm(f));
      continue;
    }
    const proj = projectForFile(f, graph.nodes);
    if (!proj) {
      unmapped.push(norm(f));
      continue;
    }
    const root = norm(graph.nodes[proj].root);
    const layer = layerOf(`${root}/`, cfg.layers);
    addTo(owns, layer, `${root}/**`);
    addTo(projs, layer, proj);
  }
  return { owns, projs, unmapped, spineFiles };
}

function layerSequence(cfg, present) {
  const order = [...cfg.layers.map((l) => l.id), OTHER];
  return Object.keys(present).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Slice X needs slice Y when a project in X depends on a project in Y. */
function needsFor(layer, projs, sliceOfProject, deps, order) {
  const needs = new Set();
  for (const p of projs[layer] || []) {
    for (const target of deps[p] || []) {
      const t = sliceOfProject[target];
      if (t && t !== layer) needs.add(t);
    }
  }
  return [...needs].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** A cycle between layers would make topoOrder throw. Drop the back-edge; the user reviews the DAG anyway. */
function breakCycles(result) {
  for (let guard = 0; guard < 100; guard++) {
    try {
      man.topoOrder(result);
      return;
    } catch (e) {
      const names = String(e.message).replace('cycle: ', '').split(' -> ');
      const from = names[names.length - 1];
      const s = result.slices.find((x) => x.id === names[names.length - 2]);
      if (!s) return;
      s.needs = s.needs.filter((n) => n !== from);
    }
  }
}

export function proposeSlices(diffFiles, graph, cfg, opts = {}) {
  const { owns, projs, unmapped, spineFiles } = classifyFiles(diffFiles, graph, cfg);
  const order = layerSequence(cfg, owns);
  const sliceOfProject = {};
  for (const layer of order) for (const p of projs[layer] || []) sliceOfProject[p] = layer;
  const titles = Object.fromEntries(cfg.layers.map((l) => [l.id, l.title || l.id]));
  const titleFor = (layer, link) => {
    const prefix = [link, opts.feature].filter(Boolean).join(': ');
    return `${prefix ? `${prefix} ` : ''}${titles[layer] || layer}`.trim();
  };

  const slices = order.map((layer) => ({
    id: layer,
    title: titleFor(layer, opts.storyRef),
    needs: graph ? needsFor(layer, projs, sliceOfProject, graph.dependencies, order) : [],
    owns: [...owns[layer]].sort(),
  }));
  const result = {
    feature: opts.feature || null,
    story: opts.story || null,
    integration: opts.integration || null,
    slices,
    spine: Object.fromEntries(spineFiles.map((f) => [f, {}])),
    unmapped,
  };
  breakCycles(result);
  // Only the top of the stack completes the story, so only its title (and so its commit) carries the closing link.
  const top = result.slices.find((s) => s.id === man.topSlice(result));
  if (top) top.title = titleFor(top.id, opts.storyLink);
  return result;
}

/** Enumerate the actual changed keys in each spine file and guess an owner. */
export function collectSpineKeys(manifest, changedKeysByFile) {
  for (const [file, keys] of Object.entries(changedKeysByFile || {})) {
    manifest.spine[file] = manifest.spine[file] || {};
    for (const key of keys || []) {
      if (!manifest.spine[file][key]) manifest.spine[file][key] = guessSpineOwner(key, manifest.slices);
    }
  }
  return manifest;
}

/** Keep the up-front sketch (ids, titles, intent) and report where reality diverged from it. */
export function reconcileWithSketch(proposal, sketch) {
  if (!sketch || !sketch.slices || !sketch.slices.length) {
    return { manifest: proposal, drift: ['no sketch to reconcile against'] };
  }
  const drift = [];
  const sketchIds = sketch.slices.map((s) => s.id);
  const propIds = proposal.slices.map((s) => s.id);
  for (const id of propIds.filter((x) => !sketchIds.includes(x))) {
    drift.push(`slice "${id}" added, it has changed files but was not in the sketch`);
  }
  for (const id of sketchIds.filter((x) => !propIds.includes(x))) {
    drift.push(`sketch slice "${id}" removed, no changed files landed in it`);
  }
  const titles = Object.fromEntries(sketch.slices.filter((s) => s.title).map((s) => [s.id, s.title]));
  for (const s of proposal.slices) if (titles[s.id]) s.title = titles[s.id];

  // Report needs-edge differences without overriding the derived graph.
  for (const ss of sketch.slices) {
    const ps = proposal.slices.find((x) => x.id === ss.id);
    if (!ps) continue;
    const a = [...(ss.needs || [])].sort().join(',');
    const b = [...(ps.needs || [])].sort().join(',');
    if (a !== b) drift.push(`slice "${ss.id}" needs changed: sketch [${a}] -> derived [${b}]`);
  }
  return { manifest: proposal, drift };
}
