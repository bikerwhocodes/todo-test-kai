// The auth role is a real boundary, asserted in BOTH directions.
//
// The open design question NEXT-2 inherited was how the auth library reads
// `users` by email and `sessions` by token when no identity exists yet. The
// rejected answer was widening nextup_runtime's grants. The answer taken is a
// third role, and these tests are what make that answer enforceable rather
// than aspirational:
//
//   * nextup_runtime still cannot touch sessions/accounts/verifications.
//   * nextup_auth cannot touch ANY domain table.
//   * the users policy is asymmetric by role, and that asymmetry is observed
//     rather than assumed.
//   * the startup guard FAILS when either half is widened, when a table loses
//     FORCE RLS, and when an unclassified table appears. A guard only ever
//     seen passing is not known to work.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { expectFailure, makeTask, makeUser, ownerPool, superPool } from "./helpers.ts";
import { assertSafeSchema, checkSchemaSafety } from "../db/guard.ts";
import { withUser } from "../db/client.ts";

const url = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};

const authPool = new pg.Pool({ connectionString: url("AUTH_DATABASE_URL"), max: 3 });
authPool.on("error", () => { /* idle client severed by a restart test */ });

test("the auth role holds NO privilege on any domain table", async () => {
  const domain = ["projects", "tasks", "task_dependencies", "recurrence_rules", "day_plans", "day_plan_items"];
  for (const t of domain) {
    const f = await expectFailure(() => authPool.query(`SELECT 1 FROM ${t} LIMIT 1`));
    assert.equal(f.code, "42501", `nextup_auth must be denied on ${t}, got: ${f.message}`);
  }
  // And it cannot write one either — a denied read with an allowed write
  // would be the worse half of the pair.
  const u = await makeUser();
  const f = await expectFailure(() =>
    authPool.query("INSERT INTO projects (user_id, name) VALUES ($1, $2)", [u.id, "forged"]));
  assert.equal(f.code, "42501");
});

test("the runtime role still holds NO privilege on the identity tables", async () => {
  // This is the invariant the rejected shortcut would have broken.
  const u = await makeUser();
  for (const t of ["sessions", "accounts", "verifications", "rate_limits"]) {
    const f = await expectFailure(() =>
      withUser(u.id, (c) => c.query(`SELECT 1 FROM ${t} LIMIT 1`)));
    assert.equal(f.code, "42501", `nextup_runtime must be denied on ${t}, got: ${f.message}`);
  }
});

test("the runtime role has no INSERT on users; account creation belongs to the auth role", async () => {
  const u = await makeUser();
  const f = await expectFailure(() => withUser(u.id, (c) =>
    c.query("INSERT INTO users (name, email) VALUES ($1, $2)", ["X", `x-${Date.now()}@example.test`])));
  assert.equal(f.code, "42501", "the runtime role must not be able to create accounts");

  // The auth role can, which is how signup works at all.
  const email = `authrole-${Date.now()}@example.test`;
  const { rowCount } = await authPool.query(
    "INSERT INTO users (name, email) VALUES ($1, $2)", ["Auth Created", email]);
  assert.equal(rowCount, 1);

  // But it cannot DELETE one. Nothing in this release deletes an account, so
  // the privilege would be dead weight on the one table that cascades to
  // everything a person owns. Asserted, not just omitted from the migration —
  // otherwise a later GRANT would restore it silently.
  const del = await expectFailure(() =>
    authPool.query("DELETE FROM users WHERE email = $1", [email]));
  assert.equal(del.code, "42501", "the auth role must not be able to delete an account");

  await superPool.query("DELETE FROM users WHERE email = $1", [email]);
});

test("the users policy is asymmetric: auth sees all rows, runtime sees one", async () => {
  const a = await makeUser();
  const b = await makeUser();

  // The runtime role, with identity bound to A, sees exactly A.
  const mine = await withUser(a.id, async (c) => {
    const { rows } = await c.query<{ id: string }>("SELECT id::text AS id FROM users");
    return rows.map((r) => r.id);
  });
  assert.deepEqual(mine, [a.id], "users_self must confine the runtime role to its own row");

  // The auth role, with no identity at all, can find a user by email — the
  // pre-identity lookup login depends on.
  const { rows } = await authPool.query<{ id: string }>(
    "SELECT id::text AS id FROM users WHERE email = $1", [b.email]);
  assert.equal(rows[0]?.id, b.id, "users_auth must permit the by-email lookup");
});

test("the auth role cannot escalate: no DDL, no RLS changes, not a superuser", async () => {
  const { rows } = await authPool.query<{ super: boolean; bypass: boolean }>(
    "SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
  assert.deepEqual({ super: rows[0]?.super, bypass: rows[0]?.bypass }, { super: false, bypass: false });

  const f = await expectFailure(() => authPool.query("ALTER TABLE users DISABLE ROW LEVEL SECURITY"));
  assert.ok(["42501", "42P01"].includes(f.code), `expected a privilege error, got ${f.code}: ${f.message}`);
});

test("the guard passes on the real schema", async () => {
  const s = await checkSchemaSafety(url("DATABASE_URL"));
  assert.deepEqual(
    { unprotected: s.unprotected, unclassified: s.unclassified, leaked: s.leakedPrivileges },
    { unprotected: [], unclassified: [], leaked: [] });
  assert.equal(s.safe, true);
});

test("R11: the guard REJECTS a widened runtime grant", async () => {
  // The exact regression the design forbids: someone "fixes" auth by granting
  // the runtime role access to sessions. Startup must stop.
  await superPool.query("GRANT SELECT ON sessions TO nextup_runtime");
  try {
    const s = await checkSchemaSafety(url("DATABASE_URL"));
    assert.equal(s.safe, false);
    assert.ok(s.leakedPrivileges.some((l) => l.includes("nextup_runtime") && l.includes("sessions")),
      `expected the leak to be named, got ${JSON.stringify(s.leakedPrivileges)}`);
    await assert.rejects(() => assertSafeSchema(url("DATABASE_URL")), /privilege split has been widened/);
  } finally {
    await superPool.query("REVOKE SELECT ON sessions FROM nextup_runtime");
  }
  assert.equal((await checkSchemaSafety(url("DATABASE_URL"))).safe, true, "state must be restored");
});

test("R11: the guard REJECTS a widened auth grant", async () => {
  await superPool.query("GRANT SELECT ON tasks TO nextup_auth");
  try {
    const s = await checkSchemaSafety(url("DATABASE_URL"));
    assert.equal(s.safe, false);
    assert.ok(s.leakedPrivileges.some((l) => l.includes("nextup_auth") && l.includes("tasks")),
      `expected the leak to be named, got ${JSON.stringify(s.leakedPrivileges)}`);
  } finally {
    await superPool.query("REVOKE SELECT ON tasks FROM nextup_auth");
  }
  assert.equal((await checkSchemaSafety(url("DATABASE_URL"))).safe, true);
});

test("R11: the guard REJECTS a table that lost FORCE ROW LEVEL SECURITY", async () => {
  await ownerPool.query("ALTER TABLE tasks NO FORCE ROW LEVEL SECURITY");
  try {
    const s = await checkSchemaSafety(url("DATABASE_URL"));
    assert.deepEqual(s.unprotected, ["tasks"]);
    await assert.rejects(() => assertSafeSchema(url("DATABASE_URL")), /not FORCE ROW LEVEL SECURITY/);
  } finally {
    await ownerPool.query("ALTER TABLE tasks FORCE ROW LEVEL SECURITY");
  }
  assert.equal((await checkSchemaSafety(url("DATABASE_URL"))).safe, true);
});

test("R11: the guard REJECTS an unclassified new table", async () => {
  // The realistic regression: a later migration adds a user-scoped table and
  // forgets its policy. Matching on a pattern would miss it; the allowlist
  // is what catches it.
  await ownerPool.query("CREATE TABLE guard_probe_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid())");
  try {
    const s = await checkSchemaSafety(url("DATABASE_URL"));
    assert.deepEqual(s.unclassified, ["guard_probe_notes"]);
    await assert.rejects(() => assertSafeSchema(url("DATABASE_URL")), /neither the RLS-required nor the RLS-exempt/);
  } finally {
    await ownerPool.query("DROP TABLE guard_probe_notes");
  }
  assert.equal((await checkSchemaSafety(url("DATABASE_URL"))).safe, true);
});

test("the auth role cannot read a task even when one exists", async () => {
  // Belt and braces on the headline claim: a real row, and the auth role
  // still cannot see it. The denial is a privilege error, not an empty result
  // that might later turn into rows if a policy changed.
  const u = await makeUser();
  await makeTask(u.id, { title: "secret" });
  const f = await expectFailure(() => authPool.query("SELECT title FROM tasks"));
  assert.equal(f.code, "42501");
});

after(async () => { await authPool.end(); });
