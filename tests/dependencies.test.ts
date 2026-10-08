// R7 — direct, transitive, self- and concurrently-created dependency cycles
// are all rejected, and the rejection does not depend on a depth bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withUser } from "../db/client.ts";
import { addDependency, DependencyCycleError } from "../db/dependencies.ts";
import { makeTask, makeUser, runtimePool, superPool } from "./helpers.ts";

const edgesFor = async (userId: string): Promise<number> => {
  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*) AS n FROM task_dependencies WHERE user_id = $1", [userId]);
  return Number(rows[0]!.n);
};

/** Does any cycle exist among this user's edges? Depth-free, so it cannot miss one. */
const cycleExists = async (userId: string): Promise<boolean> => {
  const { rows } = await superPool.query<{ present: boolean }>(`
    WITH RECURSIVE walk(start_id, id) AS (
        SELECT task_id, depends_on_id FROM task_dependencies WHERE user_id = $1
      UNION
        SELECT w.start_id, d.depends_on_id
          FROM task_dependencies d JOIN walk w ON d.task_id = w.id
         WHERE d.user_id = $1
    )
    SELECT EXISTS (SELECT 1 FROM walk WHERE start_id = id) AS present`, [userId]);
  return rows[0]!.present;
};

test("R7: a direct cycle A->B then B->A is rejected", async () => {
  const u = await makeUser();
  const [a, b] = [await makeTask(u.id, { title: "A" }), await makeTask(u.id, { title: "B" })];

  await withUser(u.id, (c) => addDependency(c, u.id, a, b), runtimePool);
  await assert.rejects(
    () => withUser(u.id, (c) => addDependency(c, u.id, b, a), runtimePool),
    DependencyCycleError);

  assert.equal(await edgesFor(u.id), 1);
  assert.equal(await cycleExists(u.id), false);
});

test("R7: a genuine non-cycle is NOT falsely rejected", async () => {
  const u = await makeUser();
  const [a, b, c2] = [await makeTask(u.id), await makeTask(u.id), await makeTask(u.id)];
  await withUser(u.id, (c) => addDependency(c, u.id, a, b), runtimePool);
  await withUser(u.id, (c) => addDependency(c, u.id, a, c2), runtimePool);
  await withUser(u.id, (c) => addDependency(c, u.id, b, c2), runtimePool);
  assert.equal(await edgesFor(u.id), 3);
  assert.equal(await cycleExists(u.id), false);
});

test("R7: a transitive cycle A->B->C then C->A is rejected", async () => {
  const u = await makeUser();
  const [a, b, c3] = [await makeTask(u.id), await makeTask(u.id), await makeTask(u.id)];
  await withUser(u.id, (c) => addDependency(c, u.id, a, b), runtimePool);
  await withUser(u.id, (c) => addDependency(c, u.id, b, c3), runtimePool);
  await assert.rejects(
    () => withUser(u.id, (c) => addDependency(c, u.id, c3, a), runtimePool),
    DependencyCycleError);
  assert.equal(await cycleExists(u.id), false);
});

test("R7: self-dependency is rejected before it reaches the database", async () => {
  const u = await makeUser();
  const a = await makeTask(u.id);
  await assert.rejects(
    () => withUser(u.id, (c) => addDependency(c, u.id, a, a), runtimePool),
    DependencyCycleError);
});

test("R7: a cycle across a 70-link chain is caught — no depth cutoff", async () => {
  const u = await makeUser();
  const CHAIN = 70; // deliberately past the depth < 64 bound that was proposed
  const ids: string[] = [];
  for (let i = 0; i < CHAIN; i++) ids.push(await makeTask(u.id, { title: `n${i}` }));

  await withUser(u.id, async (c) => {
    for (let i = 0; i < CHAIN - 1; i++) await addDependency(c, u.id, ids[i]!, ids[i + 1]!);
  }, runtimePool);
  assert.equal(await edgesFor(u.id), CHAIN - 1);

  // Closing the loop from the far end must be rejected.
  await assert.rejects(
    () => withUser(u.id, (c) => addDependency(c, u.id, ids[CHAIN - 1]!, ids[0]!), runtimePool),
    DependencyCycleError, "a 70-link cycle must be detected");

  // And prove the depth-bounded variant WOULD have missed it, so the absence of
  // a depth column stays a deliberate requirement rather than an accident.
  const { rows } = await superPool.query<{ bounded: boolean; unbounded: boolean }>(`
    WITH RECURSIVE bounded(id, depth) AS (
        SELECT depends_on_id, 1 FROM task_dependencies WHERE user_id = $1 AND task_id = $2
      UNION
        SELECT d.depends_on_id, b.depth + 1 FROM task_dependencies d
          JOIN bounded b ON d.task_id = b.id
         WHERE d.user_id = $1 AND b.depth < 64
    ), unbounded(id) AS (
        SELECT depends_on_id FROM task_dependencies WHERE user_id = $1 AND task_id = $2
      UNION
        SELECT d.depends_on_id FROM task_dependencies d
          JOIN unbounded r ON d.task_id = r.id
         WHERE d.user_id = $1
    )
    SELECT EXISTS (SELECT 1 FROM bounded   WHERE id = $3) AS bounded,
           EXISTS (SELECT 1 FROM unbounded WHERE id = $3) AS unbounded`,
    [u.id, ids[0]!, ids[CHAIN - 1]!]);

  assert.equal(rows[0]!.unbounded, true, "the depth-free search finds the far end");
  assert.equal(rows[0]!.bounded, false,
    "the depth<64 variant misses it — which is why there is no depth column");
});

test("R7: concurrently-created cycles are rejected (advisory lock)", async () => {
  const u = await makeUser();
  const [t1, t2, t3] = [await makeTask(u.id), await makeTask(u.id), await makeTask(u.id)];
  // Existing edge: t1 depends on t2.
  await withUser(u.id, (c) => addDependency(c, u.id, t1, t2), runtimePool);

  // Two transactions, each individually acyclic, racing to close t1->t2->t3->t1.
  const race = (taskId: string, dependsOnId: string) =>
    withUser(u.id, async (c) => {
      await addDependency(c, u.id, taskId, dependsOnId);
      await c.query("SELECT pg_sleep(0.6)"); // hold the transaction open
    }, runtimePool);

  const results = await Promise.allSettled([race(t2, t3), race(t3, t1)]);
  const rejected = results.filter((r) => r.status === "rejected").length;

  assert.equal(rejected, 1, "exactly one of the two racing writers must be rejected");
  assert.equal(await edgesFor(u.id), 2, "two edges, not three");
  assert.equal(await cycleExists(u.id), false, "no cycle may exist after the race");
});

test("R7 control: WITHOUT the advisory lock the same race corrupts the graph", async () => {
  const u = await makeUser();
  const [t1, t2, t3] = [await makeTask(u.id), await makeTask(u.id), await makeTask(u.id)];
  await withUser(u.id, (c) => addDependency(c, u.id, t1, t2), runtimePool);

  // Identical to addDependency except the lock is omitted and the check-then-insert
  // window is widened. This is a control, not production code: it exists so the
  // lock in db/dependencies.ts is demonstrably load-bearing rather than assumed.
  const unsafe = (taskId: string, dependsOnId: string) =>
    withUser(u.id, async (c) => {
      const { rows } = await c.query<{ creates_cycle: boolean }>(`
        WITH RECURSIVE reachable(id) AS (
            SELECT depends_on_id FROM task_dependencies WHERE user_id = $1 AND task_id = $2
          UNION
            SELECT d.depends_on_id FROM task_dependencies d
              JOIN reachable r ON d.task_id = r.id WHERE d.user_id = $1
        ) SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $3) AS creates_cycle`,
        [u.id, dependsOnId, taskId]);
      if (rows[0]!.creates_cycle) throw new Error("cycle");
      await c.query("SELECT pg_sleep(0.6)");
      await c.query(
        "INSERT INTO task_dependencies (user_id, task_id, depends_on_id) VALUES ($1,$2,$3)",
        [u.id, taskId, dependsOnId]);
    }, runtimePool);

  const results = await Promise.allSettled([unsafe(t2, t3), unsafe(t3, t1)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2,
    "both unlocked writers commit — each was individually acyclic");
  assert.equal(await edgesFor(u.id), 3);
  assert.equal(await cycleExists(u.id), true,
    "the unlocked path creates a real cycle, which is exactly what the lock prevents");
});
