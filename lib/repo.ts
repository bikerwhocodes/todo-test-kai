// Owner-scoped data access.
//
// The rule that makes A2/A3 structural rather than remembered: NO function
// here takes a row id without also taking the caller's user id. There is no
// `getTask(id)` to call by mistake — the unscoped query is not expressible.
//
// Three layers have to agree before a cross-account read can happen, and they
// are independent:
//   1. these queries, which carry `AND user_id = $owner`;
//   2. RLS, FORCEd on every table, which would return zero rows even if (1)
//      were written wrong (002_security.sql);
//   3. the composite foreign keys, which make a cross-owner LINK unrepresentable
//      rather than merely unauthorized (001_schema.sql).
import type pg from "pg";
import { withUser } from "../db/client.ts";
import { addDependency } from "../db/dependencies.ts";
import { notFound } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guards every id that is about to name a row in SQL.
 *
 * Without this, a non-UUID path segment reached Postgres and raised
 * `22P02 invalid input syntax for type uuid`, which surfaced as **500
 * INTERNAL** on eight endpoints — `GET /api/tasks/abc` and friends. A 500 for
 * user-supplied input is wrong twice over: it reports a server fault for a
 * client mistake, and it fills the logs with noise that hides real faults.
 *
 * The answer is 404, not 422, and the same 404 every other unknown id gets.
 * A malformed id cannot name a row, so "no such row you own" is exactly true —
 * and it keeps malformed, foreign and nonexistent ids **indistinguishable**,
 * which is what A3 requires. A 422 here would leak that an id was well-formed,
 * re-introducing in miniature the enumeration oracle the 404 rule removes.
 *
 * This lives in the repository rather than in each route so a new route cannot
 * forget it: there is no way to query without passing through here.
 */
const rowId = (v: string): string => {
  if (!UUID.test(v)) throw notFound();
  return v;
};

export type Project = { id: string; name: string; archivedAt: string | null; createdAt: string };
export type Task = {
  id: string; title: string; notes: string | null; priority: number;
  projectId: string | null; parentTaskId: string | null;
  estimateMinutes: number | null; deadline: string | null; startDate: string | null;
  completedAt: string | null; createdAt: string;
};

const PROJECT_COLS = `id, name, archived_at AS "archivedAt", created_at AS "createdAt"`;
const TASK_COLS = `
  id, title, notes, priority,
  project_id AS "projectId", parent_task_id AS "parentTaskId",
  estimate_minutes AS "estimateMinutes",
  deadline, start_date AS "startDate",
  completed_at AS "completedAt", created_at AS "createdAt"`;

/**
 * Serialises a `date` column as YYYY-MM-DD (P4).
 *
 * **Do not reach for `toISOString()` here.** `pg` parses a `date` column into a
 * JS `Date` at **local midnight**, and `toISOString()` re-reads that instant in
 * UTC — which moves the day BACKWARDS for every timezone east of UTC.
 * Reproduced against the real database before this fix: a task stored with
 * `deadline = 2026-12-01` was reported by the API as **2026-11-30** under
 * `TZ=Pacific/Auckland` and under `TZ=Europe/Berlin`, while `TZ=UTC` and
 * `TZ=America/Edmonton` looked correct. So it was silent, wrong for roughly
 * half the world, and invisible to a UTC CI runner.
 *
 * This is the exact off-by-one `tests/dates.test.ts` already demonstrates for
 * the *storage* model — the schema was right and the serialisation layer
 * reintroduced the bug on the two fields day planning keys on.
 *
 * Reading the local components back out is correct because local midnight is
 * precisely what the parsed value represents. `tests/dates.test.ts` now pins
 * it, and CI runs the whole suite a second time under an eastern timezone.
 */
const asDate = (v: unknown): string | null => {
  if (v == null) return null;
  // Already a plain `YYYY-MM-DD` (e.g. a `::text` cast) — nothing to convert.
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v);
};

const asInstant = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

const toTask = (r: Record<string, unknown>): Task => ({
  id: r.id as string,
  title: r.title as string,
  notes: (r.notes as string | null) ?? null,
  priority: r.priority as number,
  projectId: (r.projectId as string | null) ?? null,
  parentTaskId: (r.parentTaskId as string | null) ?? null,
  estimateMinutes: (r.estimateMinutes as number | null) ?? null,
  deadline: asDate(r.deadline),
  startDate: asDate(r.startDate),
  completedAt: asInstant(r.completedAt),
  createdAt: asInstant(r.createdAt) as string,
});

const toProject = (r: Record<string, unknown>): Project => ({
  id: r.id as string,
  name: r.name as string,
  archivedAt: asInstant(r.archivedAt),
  createdAt: asInstant(r.createdAt) as string,
});

// --- projects ---------------------------------------------------------------

export const listProjects = (userId: string): Promise<Project[]> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT ${PROJECT_COLS} FROM projects WHERE user_id = $1 ORDER BY created_at`, [userId]);
    return rows.map(toProject);
  });

export const createProject = (userId: string, name: string): Promise<Project> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING ${PROJECT_COLS}`,
      [userId, name]);
    return toProject(rows[0]!);
  });

export const getProject = (userId: string, id: string): Promise<Project> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1 AND user_id = $2`, [rowId(id), userId]);
    // Missing and not-yours are the same answer (A3).
    if (!rows[0]) throw notFound();
    return toProject(rows[0]);
  });

export const renameProject = (userId: string, id: string, name: string): Promise<Project> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query(
      `UPDATE projects SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING ${PROJECT_COLS}`,
      [rowId(id), userId, name]);
    if (!rows[0]) throw notFound();
    return toProject(rows[0]);
  });

export const deleteProject = (userId: string, id: string): Promise<void> =>
  withUser(userId, async (c) => {
    const { rowCount } = await c.query(
      "DELETE FROM projects WHERE id = $1 AND user_id = $2", [rowId(id), userId]);
    if (!rowCount) throw notFound();
  });

// --- tasks ------------------------------------------------------------------

export const listTasks = (userId: string, projectId?: string): Promise<Task[]> =>
  withUser(userId, async (c) => {
    const { rows } = projectId
      ? await c.query(
          `SELECT ${TASK_COLS} FROM tasks WHERE user_id = $1 AND project_id = $2 ORDER BY created_at`,
          [userId, rowId(projectId)])
      : await c.query(
          `SELECT ${TASK_COLS} FROM tasks WHERE user_id = $1 ORDER BY created_at`, [userId]);
    return rows.map(toTask);
  });

export type NewTask = {
  title: string; projectId?: string | null; parentTaskId?: string | null;
  notes?: string | null; priority?: number; estimateMinutes?: number | null;
  deadline?: string | null; startDate?: string | null;
};

export const createTask = (userId: string, t: NewTask): Promise<Task> =>
  withUser(userId, async (c) => {
    // A foreign project_id or parent_task_id does not need checking here: the
    // composite FKs reference (id, user_id), so another user's id cannot be
    // referenced at all. The catch below turns that structural rejection into
    // the same 404 any other unknown id gets, rather than leaking a 500 whose
    // constraint name would confirm the row exists.
    try {
      const { rows } = await c.query(
        `INSERT INTO tasks (user_id, title, notes, priority, project_id, parent_task_id,
                            estimate_minutes, deadline, start_date)
         VALUES ($1, $2, $3, coalesce($4, 3), $5, $6, $7, $8, $9)
         RETURNING ${TASK_COLS}`,
        [userId, t.title, t.notes ?? null, t.priority ?? null,
         t.projectId == null ? null : rowId(t.projectId),
         t.parentTaskId == null ? null : rowId(t.parentTaskId),
         t.estimateMinutes ?? null, t.deadline ?? null, t.startDate ?? null]);
      return toTask(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === "23503") throw notFound();
      throw err;
    }
  });

export const getTask = (userId: string, id: string): Promise<Task> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT ${TASK_COLS} FROM tasks WHERE id = $1 AND user_id = $2`, [rowId(id), userId]);
    if (!rows[0]) throw notFound();
    return toTask(rows[0]);
  });

const EDITABLE: Record<string, string> = {
  title: "title", notes: "notes", priority: "priority",
  projectId: "project_id", estimateMinutes: "estimate_minutes",
  deadline: "deadline", startDate: "start_date",
};

export const updateTask = (userId: string, id: string, patch: Record<string, unknown>): Promise<Task> =>
  withUser(userId, async (c) => {
    const keys = Object.keys(patch).filter((k) => k in EDITABLE);
    if (keys.length === 0) throw notFound();
    // A body-supplied project id is a row address too, so it gets the same
    // guard and the same 404 a foreign project id already gets.
    if (patch.projectId != null) patch.projectId = rowId(String(patch.projectId));
    // Column names come from the EDITABLE allowlist, never from the request,
    // so no request key reaches the SQL text; values stay bound.
    const sets = keys.map((k, i) => `${EDITABLE[k]} = $${i + 3}`).join(", ");
    try {
      const { rows } = await c.query(
        `UPDATE tasks SET ${sets}, updated_at = now()
          WHERE id = $1 AND user_id = $2 RETURNING ${TASK_COLS}`,
        [rowId(id), userId, ...keys.map((k) => patch[k])]);
      if (!rows[0]) throw notFound();
      return toTask(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23503") throw notFound();
      throw err;
    }
  });

export const deleteTask = (userId: string, id: string): Promise<void> =>
  withUser(userId, async (c) => {
    const { rowCount } = await c.query(
      "DELETE FROM tasks WHERE id = $1 AND user_id = $2", [rowId(id), userId]);
    if (!rowCount) throw notFound();
  });

// --- dependencies -----------------------------------------------------------

/**
 * Links two tasks, both of which must belong to the caller.
 *
 * Ownership is checked explicitly so a foreign id returns 404 rather than a
 * foreign-key error. Cycle rejection and the per-user advisory lock are
 * db/dependencies.ts's, reused rather than reimplemented — that code is
 * already covered by NEXT-1's suite, including the race that needs the lock.
 */
export const linkDependency = (userId: string, taskId: string, dependsOnId: string): Promise<void> =>
  withUser(userId, async (c: pg.PoolClient) => {
    const { rows } = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tasks WHERE user_id = $1 AND id = ANY($2::uuid[])",
      [userId, [rowId(taskId), rowId(dependsOnId)]]);
    // Both ids must resolve to the caller's own tasks. A foreign id is
    // indistinguishable from a missing one.
    const wanted = taskId === dependsOnId ? 1 : 2;
    if (Number(rows[0]?.n ?? 0) !== wanted) throw notFound();
    await addDependency(c, userId, taskId, dependsOnId);
  });

export const listDependencies = (userId: string, taskId: string): Promise<string[]> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query<{ depends_on_id: string }>(
      "SELECT depends_on_id FROM task_dependencies WHERE user_id = $1 AND task_id = $2 ORDER BY created_at",
      [userId, taskId]);
    return rows.map((r) => r.depends_on_id);
  });
