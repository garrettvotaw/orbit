// Structured merging for allowlisted shared files.
//
// Most files belong to exactly one slice, so materializing them is a plain `git checkout <integration> -- <path>`.
// Spine files break that: every slice adds a path alias or a barrel export, so whole-file assignment to slice 1
// would ship an alias pointing at a library that doesn't exist yet.
//
// For those few files the manifest assigns individual keys, and the merge is structural. JSON via dotted paths;
// barrel files via whole export lines. Deliberately not an AST rewriter for real source: that is how this stays
// deterministic and re-runnable.

const segs = (p) => String(p).split('.');

export function getDotted(obj, p) {
  let cur = obj;
  for (const s of segs(p)) {
    if (cur === null || typeof cur !== 'object' || !(s in cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

export function setDotted(obj, p, val) {
  const s = segs(p);
  let cur = obj;
  for (const k of s.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[s[s.length - 1]] = val;
}

export function deleteDotted(obj, p) {
  const s = segs(p);
  let cur = obj;
  for (const k of s.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) return;
    cur = cur[k];
  }
  delete cur[s[s.length - 1]];
}

/** Start from the base file and copy in only the keys this slice owns. */
export function mergeJsonSpine(baseText, integrationText, keys) {
  const base = JSON.parse(baseText);
  const integ = JSON.parse(integrationText);
  for (const k of keys || []) {
    const v = getDotted(integ, k);
    if (v === undefined) deleteDotted(base, k);
    else setDotted(base, k, v);
  }
  return JSON.stringify(base, null, 2) + (/\n$/.test(baseText) ? '\n' : '');
}

/** Append only this slice's export lines. Idempotent. */
export function mergeBarrelSpine(baseText, _integrationText, lines) {
  const existing = String(baseText).split('\n');
  let out = String(baseText);
  if (out.length && !out.endsWith('\n')) out += '\n';
  for (const l of lines || []) if (!existing.includes(l)) out += `${l}\n`;
  return out;
}

export const isJsonSpine = (file) => /\.jsonc?$/.test(String(file));
