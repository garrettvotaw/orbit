import type { PersistedLane, PersistedState, HostSnapshot, Rates } from '../shared/types.ts';
import { RowTable, tx, type Db } from './db.ts';

/** The lanes table, one row per lane session kept on disk, field for field with `PersistedLane`. */
export function laneRows(db: Db): RowTable<PersistedLane> {
  return new RowTable<PersistedLane>(db, 'lanes', ['id', 'sessionId', 'status', 'startedAt', 'costUsd']);
}

/** Read one JSON value from the meta table, or undefined when it was never written. */
function readMeta<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

function writeMeta(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

export function loadState(db: Db): PersistedState {
  return {
    lanes: laneRows(db).all(),
    savedAt: readMeta<number>(db, 'savedAt') ?? 0,
    rates: readMeta<Rates>(db, 'rates') ?? {},
    spent: readMeta<{ day: string; usd: number }>(db, 'spent'),
  };
}

/** Everything worth keeping across a restart: lane sessions, learned prices, today's spend. */
export interface StateExtras {
  rates: Rates;
  spent: { day: string; usd: number };
}

export function toPersisted(s: HostSnapshot, extras: StateExtras): PersistedState {
  return {
    savedAt: Date.now(),
    lanes: s.lanes.map((l) => ({
      id: l.id,
      sessionId: l.sessionId,
      status: l.status,
      startedAt: l.startedAt,
      costUsd: l.costUsd,
    })),
    rates: extras.rates,
    spent: extras.spent,
  };
}

/** Lanes, prices, and spend in one transaction, so a crash leaves the last whole save. */
export function saveState(db: Db, state: PersistedState): void {
  const lanes = laneRows(db);
  tx(db, () => {
    db.exec('DELETE FROM lanes');
    lanes.put(state.lanes);
    writeMeta(db, 'savedAt', state.savedAt);
    writeMeta(db, 'rates', state.rates ?? {});
    if (state.spent) writeMeta(db, 'spent', state.spent);
  });
}

export function createStateSaver(db: Db, extras: () => StateExtras, debounceMs = 500): (s: HostSnapshot) => void {
  let timer: NodeJS.Timeout | null = null;
  let latest: HostSnapshot | null = null;
  return (s) => {
    latest = s;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (latest) saveState(db, toPersisted(latest, extras()));
    }, debounceMs);
  };
}
