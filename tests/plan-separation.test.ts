// R8 / AT-1-F — plan membership is structurally separate from task deadline.
//
// This is the release's proxy for the success scenario. It persists the AT-1
// fixture (three projects, nine tasks, one blocked by an incomplete task, and
// an accepted day plan over a subset) and proves the foundation can CARRY that
// scenario. It does not claim the scenario works: there is no scheduler here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withUser } from "../db/client.ts";
import { expectFailure, makeProject, makeTask, makeUser, runtimePool, superPool } from "./helpers.ts";
import { addDependency } from "../db/dependencies.ts";
import { updateTask } from "../lib/repo.ts";

type Fixture = {
  userId: string;
  taskIds: string[];
  blockedId: string;
  blockerId: string;
  planId: string;
};

async function buildAt1Fixture(): Promise<Fixture> {
  const u = await makeUser("America/Edmonton");
  const projects = await Promise.all([
    makeProject(u.id, "Client site"), makeProject(u.id, "Internal tool"), makeProject(u.id, "Admin"),
  ]);

  const taskIds = await withUser(u.id, async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO tasks (user_id, project_id, title, estimate_minutes, deadline, priority)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [u.id, projects[i % 3]!, `Task ${i + 1}`, 30 + i * 5,
         i % 2 === 0 ? "2026-10-15" : null, (i % 4) + 1]);
      ids.push(rows[0]!.id);
    }
    return ids;
  }, runtimePool);

  // Task 1 is blocked by Task 2, which is NOT complete.
  const [blockedId, blockerId] = [taskIds[0]!, taskIds[1]!];
  await withUser(u.id, (c) => addDependency(c, u.id, blockedId, blockerId), runtimePool);

  const planId = await withUser(u.id, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO day_plans (user_id, plan_date, status, accepted_at, available_minutes)
       VALUES ($1,'2026-10-12','accepted', now(), 120) RETURNING id`, [u.id]);
    const id = rows[0]!.id;
    // A subset: three of the nine tasks.
    for (const [n, taskId] of [taskIds[2]!, taskIds[4]!, taskIds[6]!].entries()) {
      await c.query(
        `INSERT INTO day_plan_items (user_id, day_plan_id, task_id, sort_order, planned_minutes)
         VALUES ($1,$2,$3,$4,$5)`, [u.id, id, taskId, n, 40]);
    }
    return id;
  }, runtimePool);

  return { userId: u.id, taskIds, blockedId, blockerId, planId };
}

test("AT-1-F: the fixture persists and queries correctly", async () => {
  const f = await buildAt1Fixture();
  const { rows } = await superPool.query<{ projects: string; tasks: string; items: string }>(`
    SELECT (SELECT count(*) FROM projects       WHERE user_id=$1)::text AS projects,
           (SELECT count(*) FROM tasks          WHERE user_id=$1)::text AS tasks,
           (SELECT count(*) FROM day_plan_items WHERE user_id=$1)::text AS items`,
    [f.userId]);
  assert.deepEqual(rows[0], { projects: "3", tasks: "9", items: "3" });
});

test("AT-1-F(a): the blocked task is identifiable by query, with no is_blocked column", async () => {
  const f = await buildAt1Fixture();

  // There is no stored flag — being blocked is derived from an incomplete dependency.
  const { rows: cols } = await superPool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='tasks' AND column_name IN ('is_blocked','blocked')`);
  assert.equal(cols.length, 0, "tasks must carry no stored blocked flag");

  const blocked = await withUser(f.userId, async (c) => {
    const { rows } = await c.query<{ id: string }>(`
      SELECT t.id FROM tasks t
       WHERE t.completed_at IS NULL
         AND EXISTS (SELECT 1 FROM task_dependencies d
                       JOIN tasks b ON b.id = d.depends_on_id
                      WHERE d.task_id = t.id AND b.completed_at IS NULL)`);
    return rows.map((r) => r.id);
  }, runtimePool);

  assert.deepEqual(blocked, [f.blockedId], "exactly the one blocked task is derivable");

  // Completing the blocker unblocks it, with no write to the blocked task.
  await superPool.query("UPDATE tasks SET completed_at = now() WHERE id = $1", [f.blockerId]);
  const stillBlocked = await withUser(f.userId, async (c) => {
    const { rows } = await c.query(`
      SELECT 1 FROM tasks t
       WHERE t.id = $1
         AND EXISTS (SELECT 1 FROM task_dependencies d
                       JOIN tasks b ON b.id = d.depends_on_id
                      WHERE d.task_id = t.id AND b.completed_at IS NULL)`, [f.blockedId]);
    return rows.length;
  }, runtimePool);
  assert.equal(stillBlocked, 0, "blocked-ness follows the blocker's state, not a stored flag");
});

test("AT-1-F(b): plan membership exists ONLY in day_plan_items", async () => {
  const { rows } = await superPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tasks'`);
  const names = rows.map((r) => r.column_name);
  for (const forbidden of ["plan_date", "planned_for_today", "planned_date", "day_plan_id", "is_planned"]) {
    assert.ok(!names.includes(forbidden),
      `tasks.${forbidden} must not exist — plan membership belongs to day_plan_items`);
  }
  assert.ok(names.includes("deadline"), "tasks.deadline does exist, and is a different thing");
});

test("AT-1-F(c): no plan operation writes any task's deadline", async () => {
  const f = await buildAt1Fixture();
  const snapshot = async () => {
    const { rows } = await superPool.query<{ id: string; deadline: string | null; updated_at: Date }>(
      "SELECT id, to_char(deadline,'YYYY-MM-DD') AS deadline, updated_at FROM tasks WHERE user_id=$1 ORDER BY id",
      [f.userId]);
    return rows.map((r) => `${r.id}|${r.deadline}|${r.updated_at.toISOString()}`);
  };

  const before = await snapshot();

  // A full plan lifecycle: new draft for another day, reorder, add, remove, accept.
  await withUser(f.userId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO day_plans (user_id, plan_date) VALUES ($1,'2026-10-13') RETURNING id", [f.userId]);
    const draft = rows[0]!.id;
    await c.query(
      `INSERT INTO day_plan_items (user_id, day_plan_id, task_id, sort_order) VALUES ($1,$2,$3,0)`,
      [f.userId, draft, f.taskIds[8]!]);
    await c.query("UPDATE day_plan_items SET sort_order = 5 WHERE day_plan_id = $1", [draft]);
    await c.query("DELETE FROM day_plan_items WHERE day_plan_id = $1 AND task_id = $2",
      [draft, f.taskIds[8]!]);
    await c.query(
      "UPDATE day_plans SET status='accepted', accepted_at=now() WHERE id=$1", [draft]);
  }, runtimePool);

  assert.deepEqual(await snapshot(), before,
    "every task's deadline and updated_at is untouched by the entire plan lifecycle");
});

// The guard for the assertion above. AT-1-F(c) compares `updated_at` before and
// after, which only carries information if SOMETHING can move it: if no code
// path ever advanced the column, the comparison would hold for every possible
// implementation and quietly certify a guarantee it was not checking.
//
// Verified the gap was real before adding this: deleting `updated_at = now()`
// from updateTask left all 94 other tests passing.
test("AT-1-F(c) is not vacuous: a real task edit DOES move updated_at", async () => {
  const u = await makeUser();
  const taskId = await makeTask(u.id, { title: "before" });

  const readStamp = async (): Promise<string> => {
    const { rows } = await superPool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM tasks WHERE id = $1", [taskId]);
    return rows[0]!.updated_at.toISOString();
  };

  const before = await readStamp();
  // now() is transaction start time, so a separate transaction is required for
  // the clock to have moved at all.
  await updateTask(u.id, taskId, { title: "after" });
  const after = await readStamp();

  assert.notEqual(after, before,
    "updateTask must advance updated_at, otherwise AT-1-F(c) compares two constants");
  assert.ok(after > before, `updated_at must move forward, not back (${before} -> ${after})`);
});

test("AT-1-F: at most one ACCEPTED plan per user per day; drafts unconstrained", async () => {
  const u = await makeUser();
  await withUser(u.id, async (c) => {
    await c.query("INSERT INTO day_plans (user_id, plan_date) VALUES ($1,'2026-10-20')", [u.id]);
    await c.query("INSERT INTO day_plans (user_id, plan_date) VALUES ($1,'2026-10-20')", [u.id]);
    await c.query(
      `INSERT INTO day_plans (user_id, plan_date, status, accepted_at)
       VALUES ($1,'2026-10-20','accepted',now())`, [u.id]);
  }, runtimePool);

  const failure = await expectFailure(() =>
    withUser(u.id, (c) => c.query(
      `INSERT INTO day_plans (user_id, plan_date, status, accepted_at)
       VALUES ($1,'2026-10-20','accepted',now())`, [u.id]), runtimePool));
  assert.equal(failure.code, "23505");
  assert.equal(failure.constraint, "day_plans_one_accepted_per_day");

  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM day_plans WHERE user_id=$1 AND status='draft'", [u.id]);
  assert.equal(rows[0]!.n, "2", "two drafts for the same day are fine");
});

test("AT-1-F: an accepted plan must carry accepted_at, and a draft must not", async () => {
  const u = await makeUser();
  const noTimestamp = await expectFailure(() =>
    withUser(u.id, (c) => c.query(
      "INSERT INTO day_plans (user_id, plan_date, status) VALUES ($1,'2026-10-21','accepted')",
      [u.id]), runtimePool));
  assert.equal(noTimestamp.constraint, "day_plans_accepted_at_pair");

  const draftWithTimestamp = await expectFailure(() =>
    withUser(u.id, (c) => c.query(
      `INSERT INTO day_plans (user_id, plan_date, status, accepted_at)
       VALUES ($1,'2026-10-22','draft',now())`, [u.id]), runtimePool));
  assert.equal(draftWithTimestamp.constraint, "day_plans_accepted_at_pair");
});
