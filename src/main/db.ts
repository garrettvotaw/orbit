import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;

/**
 * node:sqlite still announces itself as experimental in Node 24. Load it with that one warning
 * dropped, so every launch doesn't print it; any other warning goes through as usual.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}
const sqlite = loadSqlite();

/** Each entry takes the database one version up; never edit one that has shipped, add another. */
const MIGRATIONS: string[] = [
  `CREATE TABLE lanes (
     id TEXT PRIMARY KEY, session_id TEXT, status TEXT, started_at INTEGER, cost_usd REAL
   );
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE decisions (
     id TEXT PRIMARY KEY, n INTEGER NOT NULL UNIQUE, lane_id TEXT, lane_name TEXT, question TEXT,
     today TEXT, proposed TEXT, options TEXT, story TEXT, asked_at INTEGER, status TEXT,
     answer TEXT, answered_at INTEGER, delivered_at INTEGER, sent_at INTEGER
   );
   CREATE TABLE stories (
     id TEXT PRIMARY KEY, parent_id TEXT, parent_name TEXT, story_id TEXT, title TEXT, brief TEXT,
     cwd TEXT, agent TEXT, model TEXT, stage TEXT, pr INTEGER, pr_url TEXT, files TEXT,
     summary TEXT, worktree TEXT, branch TEXT, started_at INTEGER, updated_at INTEGER, reports TEXT
   );
   CREATE TABLE mail (
     id INTEGER PRIMARY KEY AUTOINCREMENT, lane_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
   );`,
  `CREATE TABLE stars (
     id TEXT PRIMARY KEY, pm_id TEXT, story_id TEXT, title TEXT, pr INTEGER, pr_url TEXT,
     sprint TEXT, at INTEGER
   );`,
  `ALTER TABLE stories ADD COLUMN waiting_on TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE stories ADD COLUMN waiting_files TEXT NOT NULL DEFAULT '[]';`,
  // Stars were stamped when a PR opened, in whatever iteration the story sat in; they are merges
  // in sprint windows now, and the next poll rebuilds them.
  `DELETE FROM stars;`,
  // Tracker sign-ins that have no CLI to keep them (Jira), encrypted with Electron's safeStorage.
  `CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // ADO strips Orbit's hidden marker from comment HTML, so Orbit remembers which comment holds it.
  `CREATE TABLE IF NOT EXISTS comment_markers (
     tracker TEXT NOT NULL, story TEXT NOT NULL, marker TEXT NOT NULL, comment_id TEXT NOT NULL,
     PRIMARY KEY (tracker, story, marker)
   );`,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Open Orbit's database (or `:memory:`), with WAL on and the schema brought up to date. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const at = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = at; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

/** Run `fn` in one transaction; inside another one it just joins it. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * One table of plain records: camelCase fields become snake_case columns, the listed fields are
 * stored as JSON text, and `undefined` is stored as null. The first key is the primary key.
 */
export class RowTable<T extends object> {
  readonly #db: Db;
  readonly #name: string;
  readonly #keys: ReadonlyArray<keyof T & string>;
  readonly #json: Set<string>;
  readonly #put;
  readonly #remove;

  constructor(
    db: Db,
    name: string,
    keys: ReadonlyArray<keyof T & string>,
    opts: { json?: ReadonlyArray<keyof T & string> } = {},
  ) {
    this.#db = db;
    this.#name = name;
    this.#keys = keys;
    this.#json = new Set(opts.json ?? []);
    const cols = keys.map(snake);
    this.#put = db.prepare(
      `INSERT OR REPLACE INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    this.#remove = db.prepare(`DELETE FROM ${name} WHERE ${cols[0]} = ?`);
  }

  /** Every row, ordered by one of the record's fields. */
  all(orderBy: keyof T & string = this.#keys[0]): T[] {
    const rows = this.#db.prepare(`SELECT * FROM ${this.#name} ORDER BY ${snake(orderBy)}`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const key of this.#keys) {
        const value = row[snake(key)] ?? null;
        out[key] = this.#json.has(key) && typeof value === 'string' ? JSON.parse(value) : value;
      }
      return out as T;
    });
  }

  put(rows: T[]): void {
    if (!rows.length) return;
    tx(this.#db, () => {
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        this.#put.run(
          ...this.#keys.map((key): SQLInputValue => {
            const value = r[key] ?? null;
            return this.#json.has(key) ? JSON.stringify(value ?? []) : (value as SQLInputValue);
          }),
        );
      }
    });
  }

  remove(ids: string[]): void {
    if (!ids.length) return;
    tx(this.#db, () => {
      for (const id of ids) this.#remove.run(id);
    });
  }

  count(): number {
    return (this.#db.prepare(`SELECT count(*) AS n FROM ${this.#name}`).get() as { n: number }).n;
  }
}
