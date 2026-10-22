import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, RowTable, SCHEMA_VERSION, tx } from '../src/main/db.ts';

interface Thing {
  id: string;
  name: string;
  tags: string[];
  note: string | null;
  at: number;
}

const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'));

test('openDb brings a new database up to the latest schema', () => {
  const db = openDb(':memory:');
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.deepEqual(tables(db), [
    'comment_markers',
    'decisions',
    'lanes',
    'mail',
    'meta',
    'secrets',
    'stars',
    'stories',
  ]);
});

test('reopening a file keeps its rows and runs no migration twice', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'orbit-db-')), 'nested', 'orbit.db');
  const first = openDb(file);
  first.prepare("INSERT INTO meta (key, value) VALUES ('k', '1')").run();
  first.close();
  const again = openDb(file);
  assert.deepEqual(
    again
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((r) => ({ ...r })),
    [{ key: 'k', value: '1' }],
  );
  assert.equal((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  again.close();
});

test('version 4 clears the stars stamped when a PR opened, so they rebuild from merges', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'orbit-db-')), 'orbit.db');
  const old = openDb(file);
  old.prepare("INSERT INTO stars (id, pm_id, sprint, at) VALUES ('story-shop-1', 'shop', 'Storefront', 1)").run();
  old.exec('PRAGMA user_version = 3');
  old.close();
  const db = openDb(file);
  assert.equal((db.prepare('SELECT count(*) AS n FROM stars').get() as { n: number }).n, 0);
  assert.equal(SCHEMA_VERSION, 6);
  db.close();
});

test('RowTable maps camelCase fields to snake_case columns, JSON lists, and nulls both ways', () => {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT, tags TEXT, note TEXT, at INTEGER)');
  const things = new RowTable<Thing>(db, 'things', ['id', 'name', 'tags', 'note', 'at'], { json: ['tags'] });
  const a: Thing = { id: 'a', name: 'Alpha', tags: ['x', 'y'], note: null, at: 1 };
  const b: Thing = { id: 'b', name: 'Beta', tags: [], note: 'n', at: 2 };
  things.put([a, b]);
  assert.deepEqual(things.all('at'), [a, b]);
  things.put([{ ...a, name: 'Alpha 2' }]);
  assert.equal(things.all('at')[0].name, 'Alpha 2', 'a put on an existing id replaces it');
  things.remove(['b']);
  assert.deepEqual(
    things.all('at').map((t) => t.id),
    ['a'],
  );
  assert.equal(things.count(), 1);
});

test('tx commits together or not at all, and nests inside another tx', () => {
  const db = openDb(':memory:');
  assert.throws(() =>
    tx(db, () => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('a', '1')").run();
      throw new Error('boom');
    }),
  );
  assert.equal((db.prepare('SELECT count(*) AS n FROM meta').get() as { n: number }).n, 0, 'rolled back');
  tx(db, () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('a', '1')").run();
    tx(db, () => db.prepare("INSERT INTO meta (key, value) VALUES ('b', '2')").run());
  });
  assert.equal((db.prepare('SELECT count(*) AS n FROM meta').get() as { n: number }).n, 2);
});
