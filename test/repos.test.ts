import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GhRunner } from '../src/main/github.ts';
import { RepoResolver } from '../src/main/repos.ts';
import type { OrbitConfig } from '../src/shared/types.ts';

const base = (over: Partial<OrbitConfig>): OrbitConfig => ({
  projects: [],
  monitors: [],
  chats: [],
  morning: [],
  alerts: { toast: true, sound: false },
  adoPollMinutes: 2,
  ...over,
});
const project = (id: string, cwd: string, githubRepo?: string) => ({
  id,
  name: id,
  agent: 'pm',
  cwd,
  kickoff: 'go',
  ...(githubRepo ? { githubRepo } : {}),
});

/** Answers `gh repo view` per folder and counts how often each folder was asked. */
function fakeGh(byCwd: Record<string, string>) {
  const asked: Record<string, number> = {};
  const gh: GhRunner = async (args, cwd) => {
    assert.deepEqual(args.slice(0, 2), ['repo', 'view']);
    asked[cwd ?? ''] = (asked[cwd ?? ''] ?? 0) + 1;
    const repo = byCwd[cwd ?? ''];
    if (!repo) throw new Error('gh: no git remotes found');
    return `${repo}\n`;
  };
  return { gh, asked };
}

test('repoFor takes the project githubRepo, then the config githubRepo, then the folder remote, asking gh once per folder', async () => {
  const { gh, asked } = fakeGh({ '/shop': 'contoso/storefront', '/wallet': 'contoso/wallet' });
  const r = new RepoResolver(gh);
  r.setConfig(
    base({ projects: [project('a', '/shop', 'contoso/override'), project('b', '/shop'), project('c', '/wallet')] }),
  );
  assert.equal(await r.repoFor('a'), 'contoso/override');
  assert.equal(await r.repoFor('b'), 'contoso/storefront');
  assert.equal(await r.repoFor('b'), 'contoso/storefront');
  assert.equal(await r.repoFor('c'), 'contoso/wallet');
  assert.equal(await r.repoFor('missing'), null);
  assert.deepEqual(asked, { '/shop': 1, '/wallet': 1 });
  r.setConfig(base({ githubRepo: 'contoso/everything', projects: [project('b', '/shop')] }));
  assert.equal(await r.repoFor('b'), 'contoso/everything');
});

test('a folder with no remote has no repo, and is asked again next time', async () => {
  const { gh, asked } = fakeGh({});
  const r = new RepoResolver(gh);
  r.setConfig(base({ projects: [project('a', '/scratch')] }));
  assert.equal(await r.repoFor('a'), null);
  assert.equal(await r.repoFor('a'), null);
  assert.equal(asked['/scratch'], 2);
});

test('all() lists every lane repo, projects first, deduped regardless of case', async () => {
  const { gh } = fakeGh({ '/shop': 'contoso/storefront', '/ops': 'contoso/ops', '/again': 'Contoso/Storefront' });
  const r = new RepoResolver(gh);
  r.setConfig(
    base({
      projects: [project('a', '/shop'), project('b', '/again')],
      monitors: [{ id: 'prs', name: 'PRs', skill: 'monitor-prs', cwd: '/ops', everyMinutes: 60, stateFile: 's.json' }],
      chats: [{ id: 'chat', name: 'Chat', cwd: '/nowhere' }],
    }),
  );
  assert.deepEqual(await r.all(), ['contoso/storefront', 'contoso/ops']);
});

test('folderFor names the first lane folder on a repo once it is known', async () => {
  const { gh } = fakeGh({ '/shop': 'contoso/storefront', '/wallet': 'contoso/wallet' });
  const r = new RepoResolver(gh);
  r.setConfig(base({ projects: [project('a', '/shop'), project('b', '/wallet')] }));
  assert.equal(r.folderFor('contoso/wallet'), null, 'unknown until resolved');
  await r.all();
  assert.equal(r.folderFor('contoso/wallet'), '/wallet');
  assert.equal(r.folderFor('CONTOSO/STOREFRONT'), '/shop');
  assert.equal(r.folderFor('contoso/missing'), null);
});
