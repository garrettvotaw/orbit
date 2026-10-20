import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/main/config.ts';
import { refOf, trackerOf, validateTracker } from '../src/main/trackers/config.ts';
import type { ProjectConfig, TrackerConfig } from '../src/shared/types.ts';

const project = (extra: Partial<ProjectConfig>): ProjectConfig => ({
  id: 'shop',
  name: 'Storefront',
  agent: 'shop-pm',
  cwd: '.',
  kickoff: 'go',
  ...extra,
});
const jira: TrackerConfig = {
  kind: 'jira',
  site: 'contoso.atlassian.net',
  projectKey: 'ACME',
  board: 42,
  epic: 'ACME-120',
};

test('trackerOf reads a legacy ado block as an ado tracker', () => {
  assert.deepEqual(trackerOf(project({ ado: { org: 'contoso', project: 'Storefront', anchorId: 1200 } })), {
    kind: 'ado',
    org: 'contoso',
    project: 'Storefront',
    anchorId: 1200,
  });
});

test('trackerOf prefers tracker over ado when both are set', () => {
  assert.deepEqual(
    trackerOf(project({ ado: { org: 'contoso', project: 'Storefront', anchorId: 1 }, tracker: jira })),
    jira,
  );
});

test('trackerOf is null for a project with neither', () => {
  assert.equal(trackerOf(project({})), null);
});

test('refOf names the sign-in', () => {
  assert.deepEqual(refOf({ kind: 'ado', org: 'contoso', project: 'p', anchorId: 1 }), { kind: 'ado', site: 'contoso' });
  assert.deepEqual(refOf(jira), { kind: 'jira', site: 'contoso.atlassian.net' });
  assert.deepEqual(refOf({ kind: 'github', repo: 'contoso/storefront', label: 'x' }), {
    kind: 'github',
    site: 'github.com',
  });
});

test('validateTracker rejects a jira tracker without a board, or with both epic and jql, or with neither', () => {
  const bad: unknown[] = [
    { ...jira, board: undefined },
    { ...jira, jql: 'labels = x' },
    { ...jira, epic: undefined },
  ];
  for (const t of bad) assert.throws(() => validateTracker(t as TrackerConfig, 'shop'), /shop/);
  assert.doesNotThrow(() => validateTracker(jira, 'shop'));
});

test('validateTracker rejects a github tracker with both project and label, or with neither', () => {
  const both = { kind: 'github', repo: 'contoso/storefront', project: 7, label: 'x' } as TrackerConfig;
  const neither = { kind: 'github', repo: 'contoso/storefront' } as TrackerConfig;
  assert.throws(() => validateTracker(both, 'shop'), /shop/);
  assert.throws(() => validateTracker(neither, 'shop'), /shop/);
  assert.doesNotThrow(() => validateTracker({ kind: 'github', repo: 'contoso/storefront', project: 7 }, 'shop'));
});

test('validateTracker rejects an ado tracker missing its anchor', () => {
  assert.throws(() => validateTracker({ kind: 'ado', org: 'contoso', project: 'p' } as TrackerConfig, 'shop'), /shop/);
});

test('validateTracker rejects a stages value that is not an Orbit stage', () => {
  const t = { ...jira, stages: { 'Code Review': 'reviewing' } } as unknown as TrackerConfig;
  assert.throws(() => validateTracker(t, 'shop'), /shop.*reviewing|reviewing.*shop/);
  assert.doesNotThrow(() => validateTracker({ ...jira, stages: { 'Code Review': 'in-review' } }, 'shop'));
});

test('normalizeConfig keeps tracker, a project githubRepo, and boardTools: false, and does not add tracker to a legacy project', () => {
  const cfg = normalizeConfig({
    projects: [
      project({ id: 'a', tracker: jira, githubRepo: 'contoso/storefront' }),
      project({ id: 'b', ado: { org: 'contoso', project: 'p', anchorId: 1 } }),
    ],
    boardTools: false,
  });
  assert.deepEqual(cfg.projects[0].tracker, jira);
  assert.equal(cfg.projects[0].githubRepo, 'contoso/storefront');
  assert.equal(cfg.boardTools, false);
  assert.ok(!JSON.stringify(cfg.projects[1]).includes('"tracker"'));
  assert.equal(normalizeConfig({}).boardTools, undefined);
});
