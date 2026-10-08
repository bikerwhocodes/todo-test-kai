// Ordered plain-SQL migrator.
//
// Why not drizzle-kit generate: the load-bearing parts of this schema are
// things a generator either cannot emit or would silently reshape — composite
// foreign keys with an ON DELETE SET NULL column list, partial unique indexes
// with predicates, CHECK constraints, triggers, RLS policies and role grants.
// These forms were validated against real Postgres before being written, and
// hand-authored SQL keeps them byte-for-byte. Drizzle is the typed query layer
// (db/schema.ts), not the migration source.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type Applied = { name: string; skipped: boolean };

export async function migrate(connectionString: string): Promise<Applied[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const results: Applied[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    if (files.length === 0) throw new Error(`no .sql files in ${MIGRATIONS_DIR}`);

    for (const name of files) {
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (rowCount) {
        results.push({ name, skipped: true });
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      // One transaction per migration: a failure leaves no partial schema and
      // no ledger row, so the next run retries it from a clean state.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
      results.push({ name, skipped: false });
    }
    return results;
  } finally {
    await client.end();
  }
}

if (import.meta.filename === process.argv[1]) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set (see .env.example)");
  const applied = await migrate(url);
  for (const r of applied) console.log(`${r.skipped ? "skip" : "APPLY"}  ${r.name}`);
  const n = applied.filter((r) => !r.skipped).length;
  console.log(n === 0 ? "Already up to date." : `Applied ${n} migration(s).`);
}
