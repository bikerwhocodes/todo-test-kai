import type pg from "pg";

export class DependencyCycleError extends Error {
  constructor(taskId: string, dependsOnId: string) {
    super(`dependency ${taskId} -> ${dependsOnId} would create a cycle`);
    this.name = "DependencyCycleError";
  }
}

/**
 * Reachability search used to reject dependency cycles.
 *
 * There is deliberately NO depth column and NO depth bound. Carrying a depth
 * is what forces a cutoff in the first place, because (id, depth) tuples never
 * repeat and so UNION can never deduplicate them. Verified: a `depth < 64`
 * variant returned "no cycle" for a real cycle on a 70-link chain — it admits
 * the very thing it is supposed to reject. Deduplicating on `id` alone both
 * removes the cutoff and guarantees termination, including when a cycle is
 * already present in the data.
 */
const REACHES_SQL = `
  WITH RECURSIVE reachable(id) AS (
      SELECT depends_on_id FROM task_dependencies
       WHERE user_id = $1 AND task_id = $2
    UNION
      SELECT d.depends_on_id FROM task_dependencies d
        JOIN reachable r ON d.task_id = r.id
       WHERE d.user_id = $1
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $3) AS creates_cycle`;

/**
 * Adds a dependency edge, rejecting cycles.
 *
 * Must run inside withUser() so that app.user_id is bound and the transaction
 * is open. The per-user advisory lock is not optional: verified, two
 * individually-acyclic transactions racing to close a cycle BOTH committed
 * without it and jointly corrupted the graph. The lock is transaction-scoped
 * (pg_advisory_xact_lock) so it is released on commit or rollback with no
 * unlock bookkeeping, and it is keyed per user so unrelated users never
 * serialize against each other.
 */
export async function addDependency(
  client: pg.PoolClient,
  userId: string,
  taskId: string,
  dependsOnId: string,
): Promise<void> {
  if (taskId === dependsOnId) throw new DependencyCycleError(taskId, dependsOnId);

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);

  const { rows } = await client.query<{ creates_cycle: boolean }>(REACHES_SQL, [
    userId, dependsOnId, taskId,
  ]);
  if (rows[0]?.creates_cycle) throw new DependencyCycleError(taskId, dependsOnId);

  await client.query(
    `INSERT INTO task_dependencies (user_id, task_id, depends_on_id)
     VALUES ($1, $2, $3) ON CONFLICT (task_id, depends_on_id) DO NOTHING`,
    [userId, taskId, dependsOnId],
  );
}
