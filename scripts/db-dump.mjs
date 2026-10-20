// Print every table in Orbit's database as JSON: npm run db:dump [-- path/to/orbit.db]
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2] ?? path.join(homedir(), '.claude', 'orbit', 'orbit.db');
if (!existsSync(file)) {
  console.error(`No database at ${file}`);
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
// JSON columns come back as text; show them as the lists and objects they hold.
const readable = (v) => {
  if (typeof v !== 'string' || !/^[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
const out = { file, version: db.prepare('PRAGMA user_version').get().user_version };
for (const t of tables) {
  out[t] = db
    .prepare(`SELECT * FROM ${t}`)
    .all()
    .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, readable(v)])));
}
console.log(JSON.stringify(out, null, 2));
