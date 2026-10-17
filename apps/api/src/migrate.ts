import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Any fixed number; it keeps two instances starting at once from racing. */
const LOCK_ID = 7_310_428;

/**
 * Applies every `migrations/NNNN_*.sql` not yet recorded in `schema_migrations`,
 * in name order, all in one transaction (a failure leaves nothing half-applied).
 * Safe to run on every start.
 * Returns the names it applied.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR, { lock = true } = {}): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return db.transaction(async (tx) => {
    if (lock) await tx.query("select pg_advisory_xact_lock($1)", [LOCK_ID]);
    await tx.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Set(
      (await tx.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
    );
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.query(await readFile(join(dir, file), "utf8"));
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
    return applied;
  });
}
