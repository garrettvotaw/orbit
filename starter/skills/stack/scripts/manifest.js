// Manifest invariants and DAG utilities. Pure, no I/O.
//
// Two invariants make a derived stack trustworthy:
//   completeness - every changed file is owned by exactly one slice
//   exclusivity  - no file is owned by two slices
// Together they guarantee the slices reconstruct the integration diff exactly, so a file can't be silently
// dropped from the stack.

export const IGNORED_PREFIXES = ['.stack/'];
export const SPINE = '__spine__';

export const norm = (p) => String(p).replace(/\\/g, '/');

const globCache = new Map();

function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else out += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * `dir/**` matches everything under a directory, `*.ext` matches by suffix anywhere, `*` stays inside one path
 * segment, and anything else is an exact path.
 */
export function matchesPattern(file, pattern) {
  const f = norm(file);
  const p = norm(pattern);
  if (p.startsWith('*') && !p.startsWith('**')) return f.endsWith(p.slice(1));
  if (!globCache.has(p)) globCache.set(p, globToRegExp(p));
  return globCache.get(p).test(f);
}

export const isIgnored = (file) => IGNORED_PREFIXES.some((p) => norm(file).startsWith(p));

export function ownersOf(file, manifest) {
  if (manifest.spine && manifest.spine[norm(file)]) return [SPINE];
  return (manifest.slices || []).filter((s) => (s.owns || []).some((p) => matchesPattern(file, p))).map((s) => s.id);
}

export function ownerOf(file, manifest) {
  const o = ownersOf(file, manifest);
  return o.length ? o[0] : null;
}

export function checkInvariants(diffFiles, manifest) {
  const unassigned = [];
  const multiOwned = [];
  for (const f of (diffFiles || []).filter((x) => !isIgnored(x))) {
    const o = ownersOf(f, manifest);
    if (o.length === 0) unassigned.push(norm(f));
    else if (o.length > 1) multiOwned.push({ file: norm(f), slices: o });
  }
  return { unassigned, multiOwned, ok: unassigned.length === 0 && multiOwned.length === 0 };
}

const byId = (manifest) => Object.fromEntries((manifest.slices || []).map((s) => [s.id, s]));

/**
 * A slice with exactly one parent stacks on that parent's branch. Zero parents means it goes straight off the
 * base branch and can be reviewed in parallel. Two or more parents (a diamond) gets no synthetic merge base: it
 * waits for both parents to land, then bases on the base branch.
 */
export function resolveBases(manifest, baseBranch = 'main') {
  const out = {};
  for (const s of manifest.slices || []) {
    const n = s.needs || [];
    out[s.id] = n.length === 1 ? n[0] : baseBranch;
  }
  return out;
}

export function topoOrder(manifest) {
  const m = byId(manifest);
  const order = [];
  const mark = {};
  const visit = (id, trail) => {
    if (mark[id] === 'done') return;
    if (mark[id] === 'open') throw new Error(`cycle: ${[...trail, id].join(' -> ')}`);
    mark[id] = 'open';
    for (const n of (m[id] || {}).needs || []) visit(n, [...trail, id]);
    mark[id] = 'done';
    order.push(id);
  };
  for (const id of Object.keys(m)) visit(id, []);
  return order;
}

/** The slice that completes the story: the last one in stack order. Only its PR may carry a closing prLink. */
export function topSlice(manifest) {
  const order = topoOrder(manifest);
  return order.length ? order[order.length - 1] : null;
}

export function ancestorsOf(id, manifest) {
  const m = byId(manifest);
  const seen = new Set();
  const walk = (cur) => {
    for (const n of (m[cur] || {}).needs || []) {
      if (!seen.has(n)) {
        seen.add(n);
        walk(n);
      }
    }
  };
  walk(id);
  return seen;
}

export const comparable = (a, b, manifest) => ancestorsOf(a, manifest).has(b) || ancestorsOf(b, manifest).has(a);

/**
 * Spine files are the only place two slices can legitimately touch the same file (both adding a path alias, say).
 * When the owning slices are DAG-incomparable they open in parallel and conflict on the second merge. That is an
 * expected trivial conflict, not an error. Do not serialize them, or the parallel fan collapses on every feature.
 */
export function spineConflicts(manifest) {
  const out = [];
  for (const [file, map] of Object.entries(manifest.spine || {})) {
    const owners = [...new Set(Object.values(map || {}).filter(Boolean))];
    const bad = new Set();
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        if (!comparable(owners[i], owners[j], manifest)) {
          bad.add(owners[i]);
          bad.add(owners[j]);
        }
      }
    }
    if (bad.size) out.push({ file, slices: [...bad] });
  }
  return out;
}

/** Slices whose dependencies have all merged, so they are safe to open now. */
export function openableSlices(manifest, state) {
  const slices = state.slices || {};
  return (manifest.slices || [])
    .filter((s) => slices[s.id] && slices[s.id].status === 'verified')
    .filter((s) => (s.needs || []).every((n) => slices[n] && slices[n].status === 'merged'))
    .map((s) => s.id);
}

/** Unresolved spine keys are a signal the user still has to arbitrate. */
export function unassignedSpineKeys(manifest) {
  const out = [];
  for (const [file, map] of Object.entries(manifest.spine || {})) {
    for (const [key, owner] of Object.entries(map || {})) if (!owner) out.push({ file, key });
  }
  return out;
}
