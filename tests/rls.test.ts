// R10 — under the ACTUAL runtime database role, raw SQL cannot read or
// forge-insert another user's rows.
//
// Every assertion here connects as nextup_runtime. A test that passed as the
// table owner or the superuser would be vacuous, because both can bypass the
// policies this file is about.
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { withUser } from "../db/client.ts";
import { expectFailure, makeTask, makeTwoUsers, ownerPool, runtimePool, superPool } from "./helpers.ts";

test("R10: the runtime role is not the owner, not a superuser, has no BYPASSRLS", async () => {
  const { rows } = await runtimePool.query<{
    role: string; rolsuper: boolean; rolbypassrls: boolean; owns: boolean;
  }>(`SELECT current_user AS role, r.rolsuper, r.rolbypassrls,
             pg_get_userbyid((SELECT relowner FROM pg_class
                               WHERE relname='tasks'
                                 AND relnamespace='public'::regnamespace)) = current_user AS owns
        FROM pg_roles r WHERE r.rolname = current_user`);
  const r = rows[0]!;
  assert.equal(r.role, "nextup_runtime");
  assert.equal(r.rolsuper, false);
  assert.equal(r.rolbypassrls, false);
  assert.equal(r.owns, false, "the runtime role must not own the tables it is constrained by");
});

test("R10: raw SELECT returns only the caller's own rows", async () => {
  const [a, b] = await makeTwoUsers();
  await makeTask(a.id, { title: "A-only" });
  await makeTask(b.id, { title: "B-only" });

  const seen = await withUser(a.id, async (c) => {
    const { rows } = await c.query<{ title: string }>("SELECT title FROM tasks");
    return rows.map((r) => r.title);
  }, runtimePool);

  assert.deepEqual(seen, ["A-only"], "an unfiltered SELECT must still be scoped by RLS");
});

test("R10: a forged INSERT carrying another user's user_id is rejected", async () => {
  const [a, b] = await makeTwoUsers();
  const failure = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query("INSERT INTO tasks (user_id, title) VALUES ($1, 'forged')", [b.id]), runtimePool));
  assert.equal(failure.code, "42501", "expected insufficient_privilege from WITH CHECK");
  assert.match(failure.message, /row-level security policy/i);
});

test("R10: cross-owner UPDATE and DELETE affect nothing and leave the victim intact", async () => {
  const [a, b] = await makeTwoUsers();
  const bTask = await makeTask(b.id, { title: "B original" });

  const counts = await withUser(a.id, async (c) => {
    const upd = await c.query("UPDATE tasks SET title = 'hijacked' WHERE id = $1", [bTask]);
    const del = await c.query("DELETE FROM tasks WHERE id = $1", [bTask]);
    return { updated: upd.rowCount, deleted: del.rowCount };
  }, runtimePool);

  assert.equal(counts.updated, 0);
  assert.equal(counts.deleted, 0);

  const { rows } = await superPool.query<{ title: string }>(
    "SELECT title FROM tasks WHERE id = $1", [bTask]);
  assert.equal(rows.length, 1, "the victim row must still exist");
  assert.equal(rows[0]!.title, "B original", "and must be byte-identical");
});

test("R10: with NO identity set the policy denies cleanly instead of erroring", async () => {
  const [a] = await makeTwoUsers();
  await makeTask(a.id, { title: "hidden" });

  const client = await runtimePool.connect();
  try {
    // No set_config at all: current_setting('app.user_id', true) is '' here.
    // The nullif() wrapper is what makes this a clean denial rather than
    // "invalid input syntax for type uuid".
    const { rows } = await client.query("SELECT * FROM tasks");
    assert.equal(rows.length, 0, "no identity must mean no rows");
  } finally {
    client.release();
  }
});

test("R10: identity is transaction-scoped and does not leak across a pooled connection", async () => {
  const [a, b] = await makeTwoUsers();
  await makeTask(a.id, { title: "A-leak-probe" });
  await makeTask(b.id, { title: "B-leak-probe" });

  // max: 1 forces every borrow onto the SAME physical connection, which is the
  // only way this can be tested. A session-level SET would persist here.
  const single = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const asA = await withUser(a.id, async (c) => {
      const { rows } = await c.query<{ title: string }>("SELECT title FROM tasks");
      return rows.map((r) => r.title);
    }, single);
    assert.deepEqual(asA, ["A-leak-probe"]);

    // Same connection, no identity: A's identity must be gone.
    const client = await single.connect();
    try {
      const { rows: leaked } = await client.query("SELECT title FROM tasks");
      assert.equal(leaked.length, 0, "A's identity leaked onto the recycled connection");
      const { rows: guc } = await client.query<{ v: string }>(
        "SELECT current_setting('app.user_id', true) AS v");
      assert.ok(guc[0]!.v === "" || guc[0]!.v === null,
        `app.user_id should be empty after COMMIT, was "${guc[0]!.v}"`);
    } finally {
      client.release();
    }

    // And the same connection serves B correctly afterwards.
    const asB = await withUser(b.id, async (c) => {
      const { rows } = await c.query<{ title: string }>("SELECT title FROM tasks");
      return rows.map((r) => r.title);
    }, single);
    assert.deepEqual(asB, ["B-leak-probe"]);
  } finally {
    await single.end();
  }
});

test("R10: FORCE constrains even the table owner (ENABLE alone would not)", async () => {
  const [a] = await makeTwoUsers();
  await makeTask(a.id, { title: "owner-visibility-probe" });

  const { rows } = await ownerPool.query("SELECT * FROM tasks");
  assert.equal(rows.length, 0,
    "nextup_owner owns tasks; without FORCE it would see every row and RLS would be inert");
});

test("R10: the runtime role cannot disable RLS or escalate", async () => {
  const noDisable = await expectFailure(() =>
    runtimePool.query("ALTER TABLE tasks DISABLE ROW LEVEL SECURITY"));
  assert.equal(noDisable.code, "42501", "must be insufficient_privilege");

  const noAuthTable = await expectFailure(() => runtimePool.query("SELECT * FROM sessions"));
  assert.equal(noAuthTable.code, "42501",
    "the runtime role holds no privilege on the auth tables");
});
