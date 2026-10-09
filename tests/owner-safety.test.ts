// R4 — invalid cross-owner links are rejected.
//
// These run as the RUNTIME role with the caller's own identity bound, so the
// row being inserted always satisfies the RLS policy (its user_id IS the
// caller). That is deliberate: it forces the FOREIGN KEY to be the thing that
// rejects the cross-owner reference, and each test asserts the SQLSTATE is
// 23503 (foreign_key_violation) and names the constraint. A test that merely
// observed "it failed" could be passing because RLS blocked it instead, which
// would leave the structural guarantee unproven.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withUser } from "../db/client.ts";
import {
  expectFailure, makeProject, makeRule, makeTask, makeTwoUsers, runtimePool, superPool,
} from "./helpers.ts";

test("R4: a task cannot reference another user's project", async () => {
  const [a, b] = await makeTwoUsers();
  const bProject = await makeProject(b.id, "B's project");

  const failure = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query("INSERT INTO tasks (user_id, title, project_id) VALUES ($1,$2,$3)",
        [a.id, "steal", bProject]), runtimePool));

  assert.equal(failure.code, "23503", `expected foreign_key_violation, got ${failure.code}`);
  assert.equal(failure.constraint, "tasks_project_owner_fk");
});

test("R4: a task CAN reference its own project (the control)", async () => {
  const [a] = await makeTwoUsers();
  const aProject = await makeProject(a.id, "A's project");
  const id = await withUser(a.id, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO tasks (user_id, title, project_id) VALUES ($1,$2,$3) RETURNING id",
      [a.id, "own", aProject]);
    return rows[0]!.id;
  }, runtimePool);
  assert.ok(id, "own-project task should insert");
});

test("R4: a task with no project is allowed (MATCH SIMPLE skips a NULL reference)", async () => {
  const [a] = await makeTwoUsers();
  const id = await withUser(a.id, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO tasks (user_id, title, project_id) VALUES ($1,$2,NULL) RETURNING id",
      [a.id, "inbox task"]);
    return rows[0]!.id;
  }, runtimePool);
  assert.ok(id, "a project-less task is a valid Inbox task");
});

test("R4: a subtask cannot have another user's task as its parent", async () => {
  const [a, b] = await makeTwoUsers();
  const bTask = await makeTask(b.id, { title: "B's task" });

  const failure = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query("INSERT INTO tasks (user_id, title, parent_task_id) VALUES ($1,$2,$3)",
        [a.id, "child", bTask]), runtimePool));

  assert.equal(failure.code, "23503");
  assert.equal(failure.constraint, "tasks_parent_owner_fk");
});

test("R4: a dependency cannot point at another user's task", async () => {
  const [a, b] = await makeTwoUsers();
  const aTask = await makeTask(a.id, { title: "A's task" });
  const bTask = await makeTask(b.id, { title: "B's task" });

  const failure = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query("INSERT INTO task_dependencies (user_id, task_id, depends_on_id) VALUES ($1,$2,$3)",
        [a.id, aTask, bTask]), runtimePool));

  assert.equal(failure.code, "23503");
  assert.equal(failure.constraint, "task_dependencies_depends_on_owner_fk");
});

test("R4: an occurrence cannot reference another user's recurrence rule", async () => {
  const [a, b] = await makeTwoUsers();
  const bRule = await makeRule(b.id);

  const failure = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query(`INSERT INTO tasks (user_id, title, recurrence_rule_id, occurrence_date)
               VALUES ($1,$2,$3,$4)`, [a.id, "occ", bRule, "2026-10-12"]), runtimePool));

  assert.equal(failure.code, "23503");
  assert.equal(failure.constraint, "tasks_recurrence_owner_fk");
});

test("R4: a day plan item cannot pull in another user's task", async () => {
  const [a, b] = await makeTwoUsers();
  const bTask = await makeTask(b.id);
  const { rows } = await superPool.query<{ id: string }>(
    "INSERT INTO day_plans (user_id, plan_date) VALUES ($1,$2) RETURNING id", [a.id, "2026-10-12"]);
  const aPlan = rows[0]!.id;

  const failure = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query(`INSERT INTO day_plan_items (user_id, day_plan_id, task_id, sort_order)
               VALUES ($1,$2,$3,0)`, [a.id, aPlan, bTask]), runtimePool));

  assert.equal(failure.code, "23503");
  assert.equal(failure.constraint, "day_plan_items_task_owner_fk");
});

test("R4: a task cannot be its own parent, and self-dependency is rejected", async () => {
  const [a] = await makeTwoUsers();
  const t = await makeTask(a.id);

  const selfParent = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query("UPDATE tasks SET parent_task_id = id WHERE id = $1", [t]), runtimePool));
  assert.equal(selfParent.constraint, "tasks_not_own_parent");

  const selfDep = await expectFailure(() =>
    withUser(a.id, (c) =>
      c.query("INSERT INTO task_dependencies (user_id, task_id, depends_on_id) VALUES ($1,$2,$2)",
        [a.id, t]), runtimePool));
  assert.equal(selfDep.constraint, "task_dependencies_no_self");
});
