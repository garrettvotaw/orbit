import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProjectBoard } from './new-orbit.ts';
import type { ProjectConfig } from '../../../../shared/types.ts';

const project = (extra: Partial<ProjectConfig>): ProjectConfig => ({
  id: 'p',
  name: 'P',
  agent: 'pm',
  cwd: '.',
  kickoff: 'go',
  ...extra,
});

test('a new PM borrows the first project ADO org and project, with no anchor yet', () => {
  assert.deepEqual(
    newProjectBoard([project({ ado: { org: 'contoso', project: 'Storefront', anchorId: 1200 } })]),
    {
      ado: { org: 'contoso', project: 'Storefront', anchorId: 0 },
    },
  );
});

test('a new PM gets no board when the first project is not on ADO, or there is none', () => {
  const jira = project({
    tracker: {
      kind: 'jira',
      site: 'contoso.atlassian.net',
      projectKey: 'ACME',
      board: 42,
      epic: 'ACME-1',
    },
  });
  assert.deepEqual(newProjectBoard([jira]), {});
  assert.deepEqual(newProjectBoard([project({})]), {});
  assert.deepEqual(newProjectBoard([]), {});
});
