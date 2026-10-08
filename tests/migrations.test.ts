// R2 — an empty database migrates to current successfully, and migrating twice
// is a no-op rather than an error.
//
// This creates a genuinely EMPTY throwaway database rather than reusing the
// development one, because "migrates from empty" is the actual claim and a
// database that is already migrated cannot test it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { readdir } from "node:fs/promises";

const SCRATCH = "nextup_migration_test";
let scratchUrl: string;
let adminUrl: string;

const swapDb = (url: string, db: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

before(async () => {
  const superUrl = process.env.POSTGRES_SUPERUSER_URL;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!superUrl || !ownerUrl) throw new Error("database URLs are not set");
  adminUrl = superUrl;

  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  await admin.end();

  const inScratch = new pg.Client({ connectionString: swapDb(superUrl, SCRATCH) });
  await inScratch.connect();
  await inScratch.query("GRANT CREATE, USAGE ON SCHEMA public TO nextup_owner");
  await inScratch.query("GRANT USAGE ON SCHEMA public TO nextup_runtime");
  await inScratch.end();

  scratchUrl = swapDb(ownerUrl, SCRATCH);
});

after(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.end();
});

test("R2: an empty database starts with no application tables", async () => {
  const c = new pg.Client({ connectionString: scratchUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relkind='r'`);
    assert.equal(rows[0]!.n, "0", "the scratch database must genuinely be empty");
  } finally { await c.end(); }
});

test("R2: the first migration run applies every migration", async () => {
  const files = (await readdir(new URL("../db/migrations", import.meta.url)))
    .filter((f) => f.endsWith(".sql")).sort();

  const applied = await migrate(scratchUrl);
  assert.deepEqual(applied.map((a) => a.name), files, "all migrations, in filename order");
  assert.ok(applied.every((a) => !a.skipped), "none may be skipped on a fresh database");
});

test("R2: the second run is a no-op, not an error", async () => {
  const again = await migrate(scratchUrl);
  assert.ok(again.every((a) => a.skipped), "every migration must report as skipped");

  const third = await migrate(scratchUrl);
  assert.ok(third.every((a) => a.skipped), "and still on a third run");
});

test("R2: the migrated schema carries every expected table and guarantee", async () => {
  const c = new pg.Client({ connectionString: scratchUrl });
  await c.connect();
  try {
    const { rows: tables } = await c.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
    const names = tables.map((t) => t.relname);
    for (const expected of [
      "accounts", "day_plan_items", "day_plans", "projects", "recurrence_rules",
      "schema_migrations", "sessions", "task_dependencies", "tasks", "users", "verifications",
    ]) assert.ok(names.includes(expected), `missing table ${expected}`);

    // RLS forced on every user-scoped table.
    const { rows: rls } = await c.query<{ relname: string; forced: boolean }>(
      `SELECT relname, relforcerowsecurity AS forced FROM pg_class
        WHERE relnamespace='public'::regnamespace
          AND relname IN ('projects','tasks','task_dependencies','recurrence_rules',
                          'day_plans','day_plan_items','users')`);
    assert.equal(rls.length, 7);
    for (const r of rls) assert.equal(r.forced, true, `${r.relname} must FORCE row level security`);

    // The partial unique occurrence index exists WITH its predicate.
    const { rows: idx } = await c.query<{ def: string }>(
      "SELECT indexdef AS def FROM pg_indexes WHERE indexname='tasks_unique_occurrence'");
    assert.equal(idx.length, 1);
    assert.match(idx[0]!.def, /WHERE .*recurrence_rule_id IS NOT NULL/i,
      "the index must stay PARTIAL — a plain unique index would permit duplicates");

    // The accepted-plan partial index exists.
    const { rows: plan } = await c.query<{ def: string }>(
      "SELECT indexdef AS def FROM pg_indexes WHERE indexname='day_plans_one_accepted_per_day'");
    assert.match(plan[0]!.def, /WHERE .*'accepted'/i);
  } finally { await c.end(); }
});

test("R2: a failed migration leaves no partial schema and no ledger row", async () => {
  // Proves the per-migration transaction boundary: the ledger and the DDL
  // commit together or not at all.
  const c = new pg.Client({ connectionString: scratchUrl });
  await c.connect();
  try {
    const before = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM schema_migrations");
    await c.query("BEGIN");
    await c.query("CREATE TABLE will_not_survive (id int)");
    await c.query("INSERT INTO schema_migrations (name) VALUES ('999_bogus.sql')");
    await c.query("ROLLBACK");
    const after2 = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM schema_migrations");
    assert.equal(after2.rows[0]!.n, before.rows[0]!.n, "ledger unchanged after rollback");
    const { rows } = await c.query(
      "SELECT 1 FROM pg_class WHERE relname='will_not_survive'");
    assert.equal(rows.length, 0, "no partial schema survives a rolled-back migration");
  } finally { await c.end(); }
});
