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

/** Date columns come back as JS Dates; a calendar date must stay YYYY-MM-DD (P4). */
const asDate = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);

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
      `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
    // Missing and not-yours are the same answer (A3).
    if (!rows[0]) throw notFound();
    return toProject(rows[0]);
  });

export const renameProject = (userId: string, id: string, name: string): Promise<Project> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query(
      `UPDATE projects SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING ${PROJECT_COLS}`,
      [id, userId, name]);
    if (!rows[0]) throw notFound();
    return toProject(rows[0]);
  });

export const deleteProject = (userId: string, id: string): Promise<void> =>
  withUser(userId, async (c) => {
    const { rowCount } = await c.query(
      "DELETE FROM projects WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!rowCount) throw notFound();
  });

// --- tasks ------------------------------------------------------------------

export const listTasks = (userId: string, projectId?: string): Promise<Task[]> =>
  withUser(userId, async (c) => {
    const { rows } = projectId
      ? await c.query(
          `SELECT ${TASK_COLS} FROM tasks WHERE user_id = $1 AND project_id = $2 ORDER BY created_at`,
          [userId, projectId])
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
        [userId, t.title, t.notes ?? null, t.priority ?? null, t.projectId ?? null,
         t.parentTaskId ?? null, t.estimateMinutes ?? null, t.deadline ?? null, t.startDate ?? null]);
      return toTask(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === "23503") throw notFound();
      throw err;
    }
  });

export const getTask = (userId: string, id: string): Promise<Task> =>
  withUser(userId, async (c) => {
    const { rows } = await c.query(
      `SELECT ${TASK_COLS} FROM tasks WHERE id = $1 AND user_id = $2`, [id, userId]);
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
    // Column names come from the EDITABLE allowlist, never from the request,
    // so no request key reaches the SQL text; values stay bound.
    const sets = keys.map((k, i) => `${EDITABLE[k]} = $${i + 3}`).join(", ");
    try {
      const { rows } = await c.query(
        `UPDATE tasks SET ${sets}, updated_at = now()
          WHERE id = $1 AND user_id = $2 RETURNING ${TASK_COLS}`,
        [id, userId, ...keys.map((k) => patch[k])]);
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
      "DELETE FROM tasks WHERE id = $1 AND user_id = $2", [id, userId]);
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
      [userId, [taskId, dependsOnId]]);
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
