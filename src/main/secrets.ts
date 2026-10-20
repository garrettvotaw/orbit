import type { Db } from './db.ts';

/** How a secret is kept at rest; in the app it is Electron's safeStorage, base64-encoded. */
export interface SecretCodec {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/** Sign-ins Orbit has to keep itself, encrypted in orbit.db and never in config.json. */
export class SecretStore {
  readonly #db: Db;
  readonly #codec: SecretCodec;

  constructor(db: Db, codec: SecretCodec) {
    this.#db = db;
    this.#codec = codec;
  }

  get(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? this.#codec.decrypt(row.value) : null;
  }

  set(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, this.#codec.encrypt(value));
  }

  delete(key: string): void {
    this.#db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
  }
}

export function jiraSecretKey(site: string): string {
  return `jira:${site}`;
}
