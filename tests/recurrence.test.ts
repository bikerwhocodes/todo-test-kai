// R5 — duplicate occurrences impossible, including under concurrency.
// R6 — a half-populated recurrence identifier/date pair is rejected.
// P8 — completed recurrence history is retained when a rule is deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withUser } from "../db/client.ts";
import { materializeOccurrence } from "../db/recurrence.ts";
import { expectFailure, makeRule, makeUser, runtimePool, superPool } from "./helpers.ts";

test("R6: half a recurrence pair is rejected, both directions", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id);

  const dateOnly = await expectFailure(() =>
    withUser(u.id, (c) => c.query(
      "INSERT INTO tasks (user_id, title, occurrence_date) VALUES ($1,'x','2026-10-12')",
      [u.id]), runtimePool));
  assert.equal(dateOnly.constraint, "recurrence_pair_complete");

  const ruleOnly = await expectFailure(() =>
    withUser(u.id, (c) => c.query(
      "INSERT INTO tasks (user_id, title, recurrence_rule_id) VALUES ($1,'x',$2)",
      [u.id, rule]), runtimePool));
  assert.equal(ruleOnly.constraint, "recurrence_pair_complete");
});

test("R5: a hard duplicate occurrence is rejected", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id);
  await withUser(u.id, (c) => c.query(
    `INSERT INTO tasks (user_id, title, recurrence_rule_id, occurrence_date)
     VALUES ($1,'first',$2,'2026-10-12')`, [u.id, rule]), runtimePool);

  const dup = await expectFailure(() =>
    withUser(u.id, (c) => c.query(
      `INSERT INTO tasks (user_id, title, recurrence_rule_id, occurrence_date)
       VALUES ($1,'second',$2,'2026-10-12')`, [u.id, rule]), runtimePool));

  assert.equal(dup.code, "23505", "expected unique_violation");
  assert.equal(dup.constraint, "tasks_unique_occurrence");
});

test("R5: non-recurring tasks are unconstrained by the partial index", async () => {
  const u = await makeUser();
  await withUser(u.id, async (c) => {
    for (let i = 0; i < 3; i++) {
      await c.query("INSERT INTO tasks (user_id, title) VALUES ($1,'plain')", [u.id]);
    }
  }, runtimePool);
  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*) AS n FROM tasks WHERE user_id = $1", [u.id]);
  assert.equal(rows[0]!.n, "3", "three NULL/NULL rows must coexist");
});

test("R5: materializeOccurrence is idempotent — ON CONFLICT restates the index predicate", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id);
  const input = { userId: u.id, recurrenceRuleId: rule, occurrenceDate: "2026-10-19", title: "Weekly" };

  const first = await withUser(u.id, (c) => materializeOccurrence(c, input), runtimePool);
  const second = await withUser(u.id, (c) => materializeOccurrence(c, input), runtimePool);

  assert.equal(first.created, true);
  assert.equal(second.created, false, "the second call must deduplicate, not error");
  assert.equal(first.taskId, second.taskId, "both calls resolve to the same occurrence");
});

test("R5: omitting the index predicate in ON CONFLICT fails — the trap is real", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id);
  // This is the research's original form. It cannot infer a partial index.
  const failure = await expectFailure(() =>
    withUser(u.id, (c) => c.query(
      `INSERT INTO tasks (user_id, title, recurrence_rule_id, occurrence_date)
       VALUES ($1,'x',$2,'2026-11-02')
       ON CONFLICT (recurrence_rule_id, occurrence_date) DO NOTHING`,
      [u.id, rule]), runtimePool));
  assert.equal(failure.code, "42P10", "expected invalid_column_reference");
  assert.match(failure.message, /no unique or exclusion constraint matching/i);
});

test("R5: concurrent generators produce exactly one occurrence", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id);
  const input = { userId: u.id, recurrenceRuleId: rule, occurrenceDate: "2026-12-01", title: "Race" };

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      withUser(u.id, (c) => materializeOccurrence(c, input), runtimePool)),
  );
  const created = results.filter((r) => r.status === "fulfilled" && r.value.created).length;

  const { rows } = await superPool.query<{ n: string }>(
    `SELECT count(*) AS n FROM tasks
      WHERE recurrence_rule_id = $1 AND occurrence_date = '2026-12-01'`, [rule]);
  assert.equal(rows[0]!.n, "1", "exactly one row must exist after 8 concurrent attempts");
  assert.ok(created <= 1, `at most one caller may report created, got ${created}`);
});

test("P8: deleting a rule retains history and never cascades", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id);
  const completedAt = "2026-10-12T17:00:00Z";
  const { rows: made } = await superPool.query<{ id: string }>(
    `INSERT INTO tasks (user_id, title, recurrence_rule_id, occurrence_date, completed_at)
     VALUES ($1,'done occurrence',$2,'2026-10-12',$3) RETURNING id`, [u.id, rule, completedAt]);
  const taskId = made[0]!.id;

  await superPool.query("DELETE FROM recurrence_rules WHERE id = $1", [rule]);

  const { rows } = await superPool.query<{
    id: string; recurrence_rule_id: string | null; occurrence_date: string | null;
    title: string; completed_at: Date;
  }>("SELECT * FROM tasks WHERE id = $1", [taskId]);

  assert.equal(rows.length, 1, "the completed occurrence must survive the rule's deletion");
  const row = rows[0]!;
  assert.equal(row.recurrence_rule_id, null, "rule link cleared");
  assert.equal(row.occurrence_date, null, "occurrence date cleared with it, keeping the pair valid");
  assert.equal(row.title, "done occurrence", "history preserved");
  assert.equal(row.completed_at.toISOString(), "2026-10-12T17:00:00.000Z");
});

test("AT-25: completed history survives an EDIT to the rule", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id, "weekly");
  const { rows: made } = await superPool.query<{ id: string }>(
    `INSERT INTO tasks (user_id, title, recurrence_rule_id, occurrence_date, completed_at)
     VALUES ($1,'done weekly',$2,'2026-10-12', '2026-10-12T18:00:00Z') RETURNING id`,
    [u.id, rule]);
  const taskId = made[0]!.id;

  // Change the rule's shape underneath the already-completed occurrence.
  await superPool.query(
    "UPDATE recurrence_rules SET freq='daily', interval_count=2, byweekday=ARRAY[1,3]::smallint[] WHERE id=$1",
    [rule]);

  const { rows } = await superPool.query<{
    occurrence_date: string; completed_at: Date; rule_id: string; title: string;
  }>(`SELECT to_char(occurrence_date,'YYYY-MM-DD') AS occurrence_date, completed_at,
             recurrence_rule_id AS rule_id, title
        FROM tasks WHERE id = $1`, [taskId]);

  assert.equal(rows.length, 1, "the completed occurrence still exists");
  assert.equal(rows[0]!.occurrence_date, "2026-10-12", "its own date is untouched by the rule edit");
  assert.equal(rows[0]!.completed_at.toISOString(), "2026-10-12T18:00:00.000Z");
  assert.equal(rows[0]!.rule_id, rule, "and it is still attached to the rule");
});

test("AT-24: reopening a completed occurrence creates no duplicate row", async () => {
  const u = await makeUser();
  const rule = await makeRule(u.id);
  const input = { userId: u.id, recurrenceRuleId: rule, occurrenceDate: "2026-10-26", title: "Weekly" };

  const first = await withUser(u.id, (c) => materializeOccurrence(c, input), runtimePool);
  await superPool.query("UPDATE tasks SET completed_at = now() WHERE id = $1", [first.taskId]);

  // Reopen, then let the generator run again — as it would on the next sweep.
  await withUser(u.id, (c) =>
    c.query("UPDATE tasks SET completed_at = NULL WHERE id = $1", [first.taskId]), runtimePool);
  const again = await withUser(u.id, (c) => materializeOccurrence(c, input), runtimePool);

  assert.equal(again.created, false);
  assert.equal(again.taskId, first.taskId);
  const { rows } = await superPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tasks
      WHERE recurrence_rule_id=$1 AND occurrence_date='2026-10-26'`, [rule]);
  assert.equal(rows[0]!.n, "1", "reopening must not spawn a second occurrence row");
});
