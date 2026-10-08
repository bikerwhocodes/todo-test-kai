// `updated_at` must tell the truth — and the AT-1-F(c) assertion must be able
// to fail.
//
// The defect these tests pin: five tables declared `updated_at timestamptz NOT
// NULL DEFAULT now()` and nothing ever advanced it. So
// plan-separation.test.ts's "every task's deadline and updated_at is untouched
// by the entire plan lifecycle" — release criterion R8 / AT-1-F(c) — could not
// fail on its `updated_at` half. A column that never moves is trivially
// untouched.
//
// Found by an independent review probe, not by this suite, which is the point:
// 83 passing tests did not notice that one of them was checking nothing.
// Fixed by db/migrations/005_maintain_updated_at.sql.
import { test } from "node:test";
import assert from "node:assert/strict";

import { withUser } from "../db/client.ts";
import { makeTask, makeUser, runtimePool, superPool } from "./helpers.ts";

/** now() is transaction start, so a same-transaction write cannot show a delta. */
const inOwnTransaction = async (userId: string, sql: string, params: unknown[]) =>
  withUser(userId, (c) => c.query(sql, params), runtimePool);

async function taskUpdatedAt(id: string): Promise<Date> {
  const { rows } = await superPool.query<{ updated_at: Date }>(
    "SELECT updated_at FROM tasks WHERE id = $1", [id]);
  return rows[0]!.updated_at;
}

test("tasks.updated_at advances on a real UPDATE through the runtime role", async () => {
  const u = await makeUser();
  const taskId = await makeTask(u.id, { title: "Original" });
  const before = await taskUpdatedAt(taskId);

  await inOwnTransaction(u.id,
    "UPDATE tasks SET title = $1 WHERE id = $2 AND user_id = $3", ["Edited", taskId, u.id]);

  const after = await taskUpdatedAt(taskId);
  assert.ok(after.getTime() > before.getTime(),
    `updated_at must advance: ${before.toISOString()} -> ${after.toISOString()}`);

  // The edit really happened, so this is not passing on a failed UPDATE.
  const { rows } = await superPool.query<{ title: string }>(
    "SELECT title FROM tasks WHERE id = $1", [taskId]);
  assert.equal(rows[0]!.title, "Edited");
});

test("AT-1-F(c) is NOT vacuous: a direct task edit moves updated_at, a plan lifecycle does not", async () => {
  // This is the control that plan-separation.test.ts was missing. It proves the
  // "untouched by the plan lifecycle" assertion is capable of failing, which is
  // the only thing that makes it evidence.
  const u = await makeUser();
  const taskId = await makeTask(u.id, { title: "Planned", deadline: "2027-03-01" });

  const beforeEdit = await taskUpdatedAt(taskId);
  await inOwnTransaction(u.id,
    "UPDATE tasks SET notes = $1 WHERE id = $2 AND user_id = $3", ["edited", taskId, u.id]);
  const afterEdit = await taskUpdatedAt(taskId);
  assert.ok(afterEdit.getTime() > beforeEdit.getTime(),
    "a direct task edit DOES move updated_at — so the assertion can fail");

  // Now the whole plan lifecycle, which must leave the task alone.
  await withUser(u.id, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO day_plans (user_id, plan_date) VALUES ($1,'2027-03-01') RETURNING id", [u.id]);
    const plan = rows[0]!.id;
    await c.query(
      "INSERT INTO day_plan_items (user_id, day_plan_id, task_id, sort_order) VALUES ($1,$2,$3,0)",
      [u.id, plan, taskId]);
    await c.query("UPDATE day_plan_items SET sort_order = 3 WHERE day_plan_id = $1", [plan]);
    await c.query("UPDATE day_plans SET status='accepted', accepted_at=now() WHERE id=$1", [plan]);
    await c.query("DELETE FROM day_plan_items WHERE day_plan_id = $1", [plan]);
  }, runtimePool);

  const afterPlan = await taskUpdatedAt(taskId);
  assert.equal(afterPlan.getTime(), afterEdit.getTime(),
    "no plan operation touches a task's updated_at");

  const { rows } = await superPool.query<{ deadline: string | null }>(
    "SELECT to_char(deadline,'YYYY-MM-DD') AS deadline FROM tasks WHERE id = $1", [taskId]);
  assert.equal(rows[0]!.deadline, "2027-03-01", "nor its deadline");
});

test("a no-op UPDATE does not move updated_at", async () => {
  // `updated_at` means "last actually changed", not "last written to" — the
  // trigger's WHEN (OLD.* IS DISTINCT FROM NEW.*) clause. Without this, a
  // caller re-saving an unchanged form would register as a change.
  const u = await makeUser();
  const taskId = await makeTask(u.id, { title: "Unchanged" });
  const before = await taskUpdatedAt(taskId);

  await inOwnTransaction(u.id,
    "UPDATE tasks SET title = title WHERE id = $1 AND user_id = $2", [taskId, u.id]);

  assert.equal((await taskUpdatedAt(taskId)).getTime(), before.getTime());
});

test("users.updated_at advances on a profile change", async () => {
  // users is reachable by the runtime role for own-row updates (timezone), so
  // this column is about to be read by /api/me in a later item.
  const u = await makeUser();
  const read = async () => {
    const { rows } = await superPool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM users WHERE id = $1", [u.id]);
    return rows[0]!.updated_at;
  };
  const before = await read();

  await inOwnTransaction(u.id,
    "UPDATE users SET timezone = $1 WHERE id = $2", ["America/Edmonton", u.id]);

  assert.ok((await read()).getTime() > before.getTime());
});

test("every table declaring updated_at has the trigger that maintains it", async () => {
  // The realistic regression is a NEW table with an updated_at column and no
  // trigger — the same way this defect arrived. This fails the build instead.
  const { rows: columns } = await superPool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'updated_at'
      ORDER BY table_name`);
  const { rows: triggers } = await superPool.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE p.proname = 'touch_updated_at' AND NOT tg.tgisinternal`);

  const withColumn = columns.map((r) => r.table_name);
  const withTrigger = new Set(triggers.map((r) => r.table_name));
  assert.ok(withColumn.length >= 5, `expected the known updated_at tables, got ${withColumn}`);

  const missing = withColumn.filter((t) => !withTrigger.has(t));
  assert.deepEqual(missing, [],
    "a table declaring updated_at with no trigger would silently never advance it");
});
