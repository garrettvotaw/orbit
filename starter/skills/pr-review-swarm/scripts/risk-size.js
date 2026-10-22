#!/usr/bin/env node
/**
 * Risk-weighted diff sizer for the pr-review-swarm skill.
 *
 * Raw line count is a poor proxy for review effort: 1,200 lines of spec files is not the same review
 * as 300 lines of auth code. This buckets a diff by path and reports weighted production lines, which
 * the orchestrator uses to pick review depth and which review agents to dispatch.
 *
 * The built-in globs are generic. A repo adds its own through `review.riskGlobs` in its profile
 * (.claude/orbit/repo.json). Profile rules are checked first, so they win over the defaults.
 *
 * Usage:
 *   node risk-size.js --pr 1234
 *   node risk-size.js --base main
 *   node risk-size.js --pr 1234 --json
 *   node risk-size.js --pr 1234 --profile path/to/repo.json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ordered most-specific-first; the first matching rule wins. weight 0 means a machine owns the file
 * and nobody reviews it. Buckets decide which agents run, see BUCKET_AGENTS.
 */
const DEFAULT_RULES = [
  // Generated or machine-owned. CI and the formatter already cover these.
  { glob: '**/dist/**', weight: 0, bucket: 'generated' },
  { glob: '**/build/**', weight: 0, bucket: 'generated' },
  { glob: '**/.nx/**', weight: 0, bucket: 'generated' },
  { glob: '**/node_modules/**', weight: 0, bucket: 'generated' },
  { glob: '**/*.lock', weight: 0, bucket: 'generated' },
  { glob: '**/package-lock.json', weight: 0, bucket: 'generated' },
  { glob: '**/*.snap', weight: 0, bucket: 'generated' },
  { glob: '**/generated/**', weight: 0, bucket: 'generated' },

  // Tests: real review, different lens. A wrong test gives false confidence.
  { glob: '**/*.spec.*', weight: 0.5, bucket: 'test' },
  { glob: '**/*.test.*', weight: 0.5, bucket: 'test' },
  { glob: '**/e2e/**', weight: 0.5, bucket: 'test' },
  { glob: '**/*-e2e/**', weight: 0.5, bucket: 'test' },
  { glob: '**/__tests__/**', weight: 0.5, bucket: 'test' },
  { glob: '**/mock-data/**', weight: 0.5, bucket: 'test' },
  { glob: '**/fixtures/**', weight: 0.5, bucket: 'test' },

  // Docs and styling: low blast radius.
  { glob: '**/*.md', weight: 0.25, bucket: 'docs' },
  { glob: '**/*.scss', weight: 0.25, bucket: 'style' },
  { glob: '**/*.css', weight: 0.25, bucket: 'style' },

  // Critical: auth and contract surfaces fail quietly.
  { glob: '**/auth/**', weight: 3, bucket: 'auth' },
  { glob: '**/*.guard.ts', weight: 3, bucket: 'auth' },
  { glob: '**/*.strategy.ts', weight: 3, bucket: 'auth' },
  { glob: '**/*.middleware.ts', weight: 3, bucket: 'auth' },
  { glob: '**/dto/**', weight: 3, bucket: 'contract' },
  { glob: '**/*.dto.ts', weight: 3, bucket: 'contract' },
  { glob: '**/*.schema.json', weight: 3, bucket: 'contract' },
  { glob: '**/openapi*.{json,yaml,yml}', weight: 3, bucket: 'contract' },

  // Elevated: logic with blast radius beyond the file.
  { glob: '**/*.effects.ts', weight: 2, bucket: 'state' },
  { glob: '**/*.reducer.ts', weight: 2, bucket: 'state' },
  { glob: '**/*.selectors.ts', weight: 2, bucket: 'state' },
  { glob: '**/store/**', weight: 2, bucket: 'state' },
  { glob: '**/*.interceptor.ts', weight: 2, bucket: 'server-logic' },
  { glob: '**/*.filter.ts', weight: 2, bucket: 'server-logic' },
  { glob: '**/*.controller.ts', weight: 2, bucket: 'server-logic' },
  { glob: '**/*.service.ts', weight: 2, bucket: 'server-logic' },
  { glob: '**/server/**/*.ts', weight: 2, bucket: 'server-logic' },

  // Baseline: visible when wrong.
  { glob: '**/*.component.ts', weight: 1, bucket: 'client' },
  { glob: '**/*.component.html', weight: 1, bucket: 'client' },
  { glob: '**/client/**/*.ts', weight: 1, bucket: 'client' },
  { glob: '**/client/**/*.html', weight: 1, bucket: 'client' },
];

const DEFAULT_RULE = { weight: 1, bucket: 'other' };

/** Buckets present in the diff to the review agents worth dispatching for them. */
const BUCKET_AGENTS = {
  auth: ['review-auth-context', 'review-silent-failure'],
  contract: ['review-contract'],
  integration: ['review-silent-failure', 'review-contract'],
  state: ['review-reactivity', 'review-silent-failure'],
  client: ['review-reactivity', 'review-bloat'],
  'server-logic': ['review-silent-failure', 'review-bloat'],
  test: ['review-test-quality'],
  other: ['review-bloat'],
};

/** Expand one `{a,b}` group so the glob converter stays simple. */
function expandBraces(glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  return m[1]
    .split(',')
    .flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

/** One brace-free glob to a regex source. Supports **, *, ? and literal path segments. */
function globToSource(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // '**/' also matches zero directories.
        if (g[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return out;
}

function globToRegExp(glob) {
  return new RegExp('^(?:' + expandBraces(glob).map(globToSource).join('|') + ')$');
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The profile path from --profile, else <repo root>/.claude/orbit/repo.json. */
function profilePath(argv) {
  const i = argv.indexOf('--profile');
  if (i !== -1) return argv[i + 1];
  try {
    return path.join(sh('git', ['rev-parse', '--show-toplevel']).trim(), '.claude', 'orbit', 'repo.json');
  } catch {
    return path.join(process.cwd(), '.claude', 'orbit', 'repo.json');
  }
}

/** The whole profile, or {} when it is missing or unreadable. A missing profile is not an error. */
function loadProfile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Profile rules first, so a repo's own globs beat the defaults. Malformed entries are skipped. */
function buildRules(profile) {
  const listed = profile.review && Array.isArray(profile.review.riskGlobs) ? profile.review.riskGlobs : [];
  const custom = listed.filter(
    (r) => r && typeof r.glob === 'string' && typeof r.weight === 'number' && typeof r.bucket === 'string',
  );
  return [...custom, ...DEFAULT_RULES].map((r) => ({ ...r, re: globToRegExp(r.glob) }));
}

function classify(rules, file) {
  const normalized = file.replace(/\\/g, '/');
  return rules.find((r) => r.re.test(normalized)) ?? DEFAULT_RULE;
}

function filesFromPr(prNumber) {
  const raw = sh('gh', [
    'api',
    `repos/{owner}/{repo}/pulls/${prNumber}/files`,
    '--paginate',
    '--jq',
    '.[] | [.filename, .additions, .deletions] | @tsv',
  ]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [file, added, removed] = line.split('\t');
      return { file, added: Number(added) || 0, removed: Number(removed) || 0 };
    });
}

function filesFromBase(base) {
  return sh('git', ['diff', '--numstat', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, file] = line.split('\t');
      return { file, added: Number(added) || 0, removed: Number(removed) || 0 };
    });
}

function recommendDepth(weighted) {
  if (weighted < 150) return 'light';
  if (weighted <= 600) return 'standard';
  return 'deep';
}

function analyze(rules, entries) {
  const buckets = new Map();
  let rawTotal = 0;
  let weightedTotal = 0;

  for (const entry of entries) {
    const rule = classify(rules, entry.file);
    const churn = entry.added + entry.removed;
    const weighted = churn * rule.weight;

    rawTotal += churn;
    weightedTotal += weighted;

    const existing = buckets.get(rule.bucket) ?? {
      bucket: rule.bucket,
      weight: rule.weight,
      files: [],
      raw: 0,
      weighted: 0,
    };
    existing.files.push(entry.file);
    existing.raw += churn;
    existing.weighted += weighted;
    buckets.set(rule.bucket, existing);
  }

  return {
    rawTotal,
    weightedTotal: Math.round(weightedTotal),
    depth: recommendDepth(weightedTotal),
    buckets: [...buckets.values()].sort((a, b) => b.weighted - a.weighted),
  };
}

function suggestedAgents(result) {
  const set = new Set();
  for (const b of result.buckets) {
    if (b.weight === 0) continue;
    for (const agent of BUCKET_AGENTS[b.bucket] ?? []) set.add(agent);
  }
  // Bloat is only worth it on genuinely large changes.
  if (result.weightedTotal < 150) set.delete('review-bloat');
  return [...set];
}

function printJson(source, result, agents, profile) {
  const out = {
    source,
    rawTotal: result.rawTotal,
    weightedTotal: result.weightedTotal,
    depth: result.depth,
    buckets: result.buckets.map((b) => ({
      bucket: b.bucket,
      weight: b.weight,
      fileCount: b.files.length,
      raw: b.raw,
      weighted: Math.round(b.weighted),
      files: b.files,
    })),
    suggestedAgents: agents,
    // Handed to review-bloat. Null means it measures the repo itself.
    sizeBands: (profile.review && profile.review.sizeBands) || null,
  };
  console.log(JSON.stringify(out, null, 2));
}

function printTable(source, result, agents) {
  console.log(`\nRisk-weighted diff: ${source}\n`);
  console.table(
    result.buckets.map((b) => ({
      bucket: b.bucket,
      weight: `${b.weight}x`,
      files: b.files.length,
      rawLines: b.raw,
      weighted: Math.round(b.weighted),
    })),
  );
  console.log(
    `Raw churn:    ${result.rawTotal} lines\n` +
      `Weighted:     ${result.weightedTotal} points\n` +
      `Review depth: ${result.depth}\n` +
      `Agents:       ${agents.join(', ') || '(none)'}\n`,
  );
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const profile = loadProfile(profilePath(argv));
  const pr = get('--pr');
  const base = get('--base') ?? (typeof profile.baseBranch === 'string' ? profile.baseBranch : 'main');
  const source = pr ? `PR #${pr}` : `${base}...HEAD`;

  let entries;
  try {
    entries = pr ? filesFromPr(pr) : filesFromBase(base);
  } catch (error) {
    console.error(`Failed to read diff (${source}): ${error.message}`);
    process.exit(1);
  }

  if (entries.length === 0) {
    console.error('No changed files found.');
    process.exit(1);
  }

  const result = analyze(buildRules(profile), entries);
  const agents = suggestedAgents(result);

  if (argv.includes('--json')) printJson(source, result, agents, profile);
  else printTable(source, result, agents);
}

main();
