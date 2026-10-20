import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Decision, PersistedLane, Rates } from '../shared/types.ts';
import { tx, type Db } from './db.ts';
import { decisionRows } from './decisions.ts';
import { saveState } from './state-store.ts';
import { mailRows, storyRows, type Mail, type StoryRecord } from './stories.ts';

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * Move one JSON file into its tables: only while those tables are empty, all in one transaction,
 * and renamed `.imported` once it commits so it is never read twice. A file that will not parse is
 * left where it is.
 */
function importFile(
  db: Db,
  file: string,
  empty: () => boolean,
  load: (parsed: Record<string, unknown>) => void,
  log: (msg: string) => void,
): boolean {
  if (!existsSync(file) || !empty()) return false;
  let parsed: Record<string, unknown>;
  try {
    const text = readFileSync(file, 'utf8');
    parsed = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (e) {
    log(`Orbit: left ${path.basename(file)} alone, it would not parse: ${(e as Error).message}`);
    return false;
  }
  tx(db, () => load(parsed));
  renameSync(file, `${file}.imported`);
  return true;
}

/** Bring the JSON files Orbit kept before its database into it, once. Returns the files moved. */
export function importLegacy(db: Db, dir: string, log: (msg: string) => void = console.warn): string[] {
  const decisions = decisionRows(db);
  const stories = storyRows(db);
  const mail = mailRows(db);
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const moved: string[] = [];
  const take = (name: string, empty: () => boolean, load: (parsed: Record<string, unknown>) => void) => {
    if (importFile(db, path.join(dir, name), empty, load, log)) moved.push(name);
  };

  take(
    'state.json',
    () => count('lanes') === 0 && count('meta') === 0,
    (p) =>
      saveState(db, {
        lanes: list<PersistedLane>(p.lanes),
        savedAt: typeof p.savedAt === 'number' ? p.savedAt : 0,
        rates: (p.rates as Rates | undefined) ?? {},
        spent: p.spent as { day: string; usd: number } | undefined,
      }),
  );
  take(
    'decisions.json',
    () => count('decisions') === 0,
    (p) => decisions.put(list<Decision>(p.decisions)),
  );
  take(
    'stories.json',
    () => count('stories') === 0 && count('mail') === 0,
    (p) => {
      stories.put(list<StoryRecord>(p.stories));
      mail.add(list<Mail>(p.mail));
    },
  );
  return moved;
}
