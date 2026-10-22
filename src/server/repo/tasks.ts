import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/server/db";
import { subtasks, tasks, type Subtask, type Task } from "@/server/db/schema";
import type { IsoDate } from "@/core/dates";
import { NO_PRIORITY, type TaskPatch } from "@/lib/validation";
import { blockersFor, type Blocker } from "./dependencies";
import { ConflictError, NotFoundError } from "./errors";
import { assertActiveProject } from "./projects";
import { completeOccurrence, reopenOccurrence } from "./series";

// Every function takes userId first and scopes every query by it.

/** A task with its subtasks and its direct blockers (any status; only open ones block). */
export type TaskWithSubtasks = Task & { subtasks: Subtask[]; blockers: Blocker[] };
export type TaskList = { open: TaskWithSubtasks[]; done: TaskWithSubtasks[] };

export async function createTask(
  userId: string,
  { title, projectId = null }: { title: string; projectId?: string | null },
): Promise<Task> {
  if (projectId) await assertActiveProject(userId, projectId);
  const [row] = await db.insert(tasks).values({ userId, title, projectId }).returning();
  return row!;
}

export async function getTask(userId: string, id: string): Promise<TaskWithSubtasks | null> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id)));
  if (!row) return null;
  const [subs, blockers] = await Promise.all([subtasksFor(userId, [row.id]), blockersFor(userId, [row.id])]);
  return { ...row, subtasks: subs.get(row.id) ?? [], blockers: blockers.get(row.id) ?? [] };
}

/** The user's open tasks in every project, for picking what a task waits on. */
export async function listOpenTaskTitles(userId: string): Promise<{ id: string; title: string }[]> {
  return db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, "open")))
    .orderBy(asc(tasks.sort), asc(tasks.createdAt), asc(tasks.id));
}

/** An open task as the Plan My Day panel's "Add a task" search lists it. */
export type PlanSearchOption = { id: string; title: string; estimateMin: number | null; projectId: string | null };

/** The user's open tasks in every project, for adding to today's plan by hand. */
export async function listOpenTasksForPlanning(userId: string): Promise<PlanSearchOption[]> {
  return db
    .select({ id: tasks.id, title: tasks.title, estimateMin: tasks.estimateMin, projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, "open")))
    .orderBy(asc(tasks.sort), asc(tasks.createdAt), asc(tasks.id));
}

/** Tasks with no project. Open first (oldest first), then completed (latest first). */
export async function listInboxTasks(userId: string): Promise<TaskList> {
  return listTasks(userId, isNull(tasks.projectId));
}

export async function listProjectTasks(userId: string, projectId: string): Promise<TaskList> {
  return listTasks(userId, eq(tasks.projectId, projectId));
}

async function listTasks(userId: string, scope: SQL): Promise<TaskList> {
  const where = (status: "open" | "done") => and(eq(tasks.userId, userId), scope, eq(tasks.status, status));
  const [open, done] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(where("open"))
      .orderBy(asc(tasks.sort), asc(tasks.createdAt), asc(tasks.id)),
    db
      .select()
      .from(tasks)
      .where(where("done"))
      .orderBy(desc(tasks.completedAt), asc(tasks.id)),
  ]);
  const all = await withSubtasksAndBlockers(userId, [...open, ...done]);
  return { open: all.slice(0, open.length), done: all.slice(open.length) };
}

/** Attaches each listed task's subtasks and blockers: one query each, not one per task. */
export async function withSubtasksAndBlockers(userId: string, rows: Task[]): Promise<TaskWithSubtasks[]> {
  const ids = rows.map((t) => t.id);
  const [subs, blockers] = await Promise.all([subtasksFor(userId, ids), blockersFor(userId, ids)]);
  return rows.map((t) => ({ ...t, subtasks: subs.get(t.id) ?? [], blockers: blockers.get(t.id) ?? [] }));
}

/** The user's subtasks of `taskIds`, grouped by task in display order. */
export async function subtasksFor(userId: string, taskIds: string[]): Promise<Map<string, Subtask[]>> {
  const map = new Map<string, Subtask[]>();
  if (taskIds.length === 0) return map;
  const rows = await db
    .select()
    .from(subtasks)
    .where(and(eq(subtasks.userId, userId), inArray(subtasks.taskId, taskIds)))
    .orderBy(asc(subtasks.sort), asc(subtasks.createdAt), asc(subtasks.id));
  for (const row of rows) {
    const list = map.get(row.taskId);
    if (list) list.push(row);
    else map.set(row.taskId, [row]);
  }
  return map;
}

/**
 * Applies only the keys present in `patch`; a null value clears that field
 * (priority goes back to "none"). Moving to a different project requires an
 * active one; re-sending the current (possibly archived) project is allowed.
 */
export async function updateTask(userId: string, id: string, patch: TaskPatch): Promise<Task> {
  if (patch.projectId) {
    const [current] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.id, id)));
    if (!current) throw new NotFoundError("task");
    if (current.projectId !== patch.projectId) await assertActiveProject(userId, patch.projectId);
  }
  const values: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.priority !== undefined) values.priority = patch.priority ?? NO_PRIORITY;
  if (patch.deadline !== undefined) values.deadline = patch.deadline;
  if (patch.estimateMin !== undefined) values.estimateMin = patch.estimateMin;
  if (patch.projectId !== undefined) values.projectId = patch.projectId;

  const [row] = await db
    .update(tasks)
    .set(values)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id)))
    .returning();
  if (!row) throw new NotFoundError("task");
  return row;
}

/**
 * Completing stamps completed_at (kept if already done); reopening clears it.
 * Occurrences of a recurring series follow the series rules instead (see ./series):
 * completing one creates the next, and only the latest closed one can be reopened.
 * `today` is the user's localToday; one-off tasks ignore it.
 */
export async function setTaskCompleted(
  userId: string,
  id: string,
  completed: boolean,
  today: IsoDate,
): Promise<Task> {
  const [current] = await db
    .select({ seriesId: tasks.seriesId })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id)));
  if (!current) throw new NotFoundError("task");
  if (current.seriesId) {
    return completed ? completeOccurrence(userId, id, today) : reopenOccurrence(userId, id);
  }

  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set(
      completed
        ? { status: "done", completedAt: sql`coalesce(${tasks.completedAt}, now())`, updatedAt: now }
        : { status: "open", completedAt: null, updatedAt: now },
    )
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id)))
    .returning();
  if (!row) throw new NotFoundError("task");
  return row;
}

/**
 * Deletes the task and (by cascade) its subtasks and its links to blockers and
 * blocked tasks. An occurrence of a recurring series can't be deleted on its
 * own: it is skipped, or the series is deleted.
 */
export async function deleteTask(userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id), isNull(tasks.seriesId)))
    .returning({ id: tasks.id });
  if (deleted.length > 0) return;
  const [occurrence] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id)));
  if (!occurrence) throw new NotFoundError("task");
  throw new ConflictError("Skip this occurrence or delete the series instead");
}
