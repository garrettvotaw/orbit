// Reviewer walkthrough of the running integration branch.
//
// This is the only part of the system that attacks cost-per-review rather than just re-ordering the review queue.
// A reviewer who can see the whole feature work in 60 seconds reviews their one slice in 15 minutes, instead of
// deferring an hour-long unknown until tomorrow.
//
// Lives under .stack/ so it is never assigned to a slice and never reaches the base branch.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const demoDir = (worktree) => path.join(worktree, '.stack', 'demo');
export const demoScriptPath = (worktree) => path.join(demoDir(worktree), 'walkthrough.spec.ts');
export const demoOutputDir = (worktree) => path.join(demoDir(worktree), 'output');

const slug = (s) =>
  String(s)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

/**
 * One test.step plus screenshot per beat of the walkthrough. Steps are written as TODOs on purpose: whoever built
 * the feature knows the real selectors, and a guessed selector that silently fails produces a misleading demo.
 */
export function buildDemoTemplate(opts) {
  const body = (opts.steps || [])
    .map((s, i) => {
      const n = String(i + 1).padStart(2, '0');
      return [
        `  await test.step('${String(s).replace(/'/g, "\\'")}', async () => {`,
        '    // TODO: drive the UI for this step',
        '    await page.screenshot({',
        `      path: \`\${OUT}/${n}-${slug(s)}.png\`,`,
        '      fullPage: true,',
        '    });',
        '  });',
      ].join('\n');
    })
    .join('\n\n');

  return [
    "import { test } from '@playwright/test';",
    '',
    `// Reviewer walkthrough for ${opts.feature}${opts.story ? ` (${opts.story})` : ''}.`,
    '// Records the feature working on the integration branch so a reviewer can',
    '// see the whole thing before reading any single slice.',
    "const OUT = '.stack/demo/output';",
    '',
    `test('walkthrough: ${opts.feature}', async ({ page }) => {`,
    body,
    '});',
    '',
  ].join('\n');
}

export function writeDemoTemplate(worktree, opts) {
  const p = demoScriptPath(worktree);
  mkdirSync(path.dirname(p), { recursive: true });
  mkdirSync(demoOutputDir(worktree), { recursive: true });
  if (existsSync(p) && !opts.force) return { path: p, created: false };
  writeFileSync(p, buildDemoTemplate(opts));
  return { path: p, created: true };
}

export function capturedScreenshots(worktree) {
  const dir = demoOutputDir(worktree);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.png$/.test(f))
    .sort();
}

/** Markdown block for every PR body in the set. */
export function prBodyDemoSection(storyRef, note) {
  return [
    '## Reviewer walkthrough',
    '',
    `The full feature running end-to-end is attached to the story (${storyRef}). Worth 60 seconds before reading this slice, since it shows where this piece fits.`,
    ...(note ? ['', note] : []),
    '',
  ].join('\n');
}

/** Standard slice header for a PR body: position, DAG, and what it owns. */
export function prBodyStackSection(opts) {
  const base = opts.baseBranch || 'the base branch';
  const needs = opts.needs || [];
  const lines = [
    `## Slice ${opts.index} of ${opts.total}: \`${opts.sliceId}\``,
    '',
    'Part of a derived PR stack. Built and validated as one running feature on',
    `\`${opts.integrationBranch}\`, then decomposed for review.`,
    '',
    `**Base:** \`${opts.base}\``,
    needs.length
      ? `**Depends on:** ${needs.map((n) => `\`${n}\``).join(', ')}`
      : `**Depends on:** nothing. Reviewable independently, straight off \`${base}\`.`,
    '',
    '**This slice owns:**',
    ...(opts.owns || []).map((o) => `- \`${o}\``),
  ];
  if (opts.dag) lines.push('', '**Full stack:**', '', '```', opts.dag, '```');
  return `${lines.join('\n')}\n`;
}

/** ASCII DAG for the PR body. */
export function renderDag(manifest, state) {
  return (manifest.slices || [])
    .map((s) => {
      const st = ((state || {}).slices || {})[s.id] || {};
      const mark = st.status === 'merged' ? '[merged]' : st.prNumber ? `[PR #${st.prNumber}]` : '[pending]';
      const dep = (s.needs || []).length ? ` <- ${s.needs.join(', ')}` : ' (off base)';
      return `  ${s.id}${dep} ${mark}`;
    })
    .join('\n');
}
