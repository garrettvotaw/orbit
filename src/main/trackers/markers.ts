import type { TrackerRef } from '../../shared/types.ts';
import type { Db } from '../db.ts';

/** Which comment carries a story's marker, for a tracker that strips Orbit's hidden tag (ADO does). */
export interface MarkerMemory {
  get(story: string, marker: string): string | null;
  set(story: string, marker: string, commentId: string): void;
  forget(story: string, marker: string): void;
}

/** Marker memory kept in orbit.db, one namespace per tracker (its kind and site). */
export class MarkerStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  for(ref: TrackerRef): MarkerMemory {
    const tracker = `${ref.kind}:${ref.site}`;
    return {
      get: (story, marker) => {
        const row = this.#db
          .prepare('SELECT comment_id FROM comment_markers WHERE tracker = ? AND story = ? AND marker = ?')
          .get(tracker, story, marker) as { comment_id: string } | undefined;
        return row?.comment_id ?? null;
      },
      set: (story, marker, commentId) => {
        this.#db
          .prepare(
            `INSERT INTO comment_markers (tracker, story, marker, comment_id) VALUES (?, ?, ?, ?)
             ON CONFLICT(tracker, story, marker) DO UPDATE SET comment_id = excluded.comment_id`,
          )
          .run(tracker, story, marker, commentId);
      },
      forget: (story, marker) => {
        this.#db
          .prepare('DELETE FROM comment_markers WHERE tracker = ? AND story = ? AND marker = ?')
          .run(tracker, story, marker);
      },
    };
  }
}
