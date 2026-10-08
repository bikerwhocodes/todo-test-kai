// R3 — data saved through the application survives a full restart of the
// application and the database, with byte-identical values.
//
// This file restarts the database container, so the suite runs with
// --test-concurrency=1 (see package.json). The "application restart" is real:
// the values are re-read through a brand-new pool after the restart, so no
// connection, cache or session state carries over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { withUser } from "../db/client.ts";
import { makeProject, makeUser, runtimePool, superPool } from "./helpers.ts";

const compose = (...args: string[]): string =>
  execFileSync("docker", ["compose", "--env-file", ".env.local", ...args], { encoding: "utf8" });

test("R3: saved data survives a full database restart with exact values", async () => {
  const u = await makeUser("Pacific/Auckland");
  const projectId = await makeProject(u.id, "Ωmega — ünïcode ✅");

  const exact = {
    title: "Pay invoice №42 — café ☕",
    notes: "line one\nline two\ttabbed, trailing space ",
    deadline: "2027-03-14",            // a DST spring-forward day
    startDate: "2026-12-31",
    estimateMinutes: 137,
    priority: 1,
    completedAt: "2026-10-09T13:45:12.345Z",
  };

  const taskId = await withUser(u.id, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO tasks (user_id, project_id, title, notes, deadline, start_date,
                          estimate_minutes, priority, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [u.id, projectId, exact.title, exact.notes, exact.deadline, exact.startDate,
       exact.estimateMinutes, exact.priority, exact.completedAt]);
    return rows[0]!.id;
  }, runtimePool);

  // Confirm it is genuinely committed and not merely visible in our own session.
  const { rows: pre } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM tasks WHERE id = $1", [taskId]);
  assert.equal(pre[0]!.n, "1");

  // --- full database restart ---
  compose("restart", "db");
  for (let i = 0; i < 60; i++) {
    try {
      if (compose("ps", "--format", "{{.Status}}").includes("healthy")) break;
    } catch { /* compose can be briefly unavailable mid-restart */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  // --- fresh pool: nothing from before the restart is reused ---
  const fresh = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  fresh.on("error", () => {});
  try {
    const row = await withUser(u.id, async (c) => {
      const { rows } = await c.query<{
        title: string; notes: string; deadline: string; start_date: string;
        estimate_minutes: number; priority: number; completed_at: Date; project_name: string;
      }>(`SELECT t.title, t.notes,
                 to_char(t.deadline,'YYYY-MM-DD')   AS deadline,
                 to_char(t.start_date,'YYYY-MM-DD') AS start_date,
                 t.estimate_minutes, t.priority, t.completed_at,
                 p.name AS project_name
            FROM tasks t JOIN projects p ON p.id = t.project_id
           WHERE t.id = $1`, [taskId]);
      return rows[0]!;
    }, fresh);

    assert.equal(row.title, exact.title, "unicode title preserved exactly");
    assert.equal(row.notes, exact.notes, "whitespace and newlines preserved exactly");
    assert.equal(row.deadline, exact.deadline);
    assert.equal(row.start_date, exact.startDate);
    assert.equal(row.estimate_minutes, exact.estimateMinutes);
    assert.equal(row.priority, exact.priority);
    assert.equal(row.completed_at.toISOString(), exact.completedAt, "instant exact to the ms");
    assert.equal(row.project_name, "Ωmega — ünïcode ✅", "related row preserved too");

    // The migration ledger also survived, so the schema was not rebuilt.
    // Compared against the files on disk rather than a hardcoded number, so
    // adding a migration cannot silently invalidate this assertion.
    const expected = (await readdir(new URL("../db/migrations", import.meta.url)))
      .filter((f) => f.endsWith(".sql")).length;
    const { rows: mig } = await fresh.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(mig[0]!.n, expected,
      `schema_migrations should record all ${expected} migration file(s)`);
  } finally {
    await fresh.end();
  }
});

test("R3: row-level security is still enforced after the restart", async () => {
  const [a, b] = [await makeUser(), await makeUser()];
  await withUser(a.id, (c) =>
    c.query("INSERT INTO tasks (user_id,title) VALUES ($1,'A post-restart')", [a.id]), runtimePool);
  await withUser(b.id, (c) =>
    c.query("INSERT INTO tasks (user_id,title) VALUES ($1,'B post-restart')", [b.id]), runtimePool);

  const seen = await withUser(a.id, async (c) => {
    const { rows } = await c.query<{ title: string }>("SELECT title FROM tasks");
    return rows.map((r) => r.title);
  }, runtimePool);
  assert.deepEqual(seen, ["A post-restart"],
    "FORCE RLS and the policies are persisted schema, not session state");
});
