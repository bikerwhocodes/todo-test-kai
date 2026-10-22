import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { subtasks, tasks, type Subtask } from "@/server/db/schema";
import { NotFoundError } from "./errors";

// Every function takes userId first and scopes every query by it.

/** Appends a subtask to one of the user's tasks. */
export async function addSubtask(userId: string, taskId: string, title: string): Promise<Subtask> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)));
  if (!task) throw new NotFoundError("task");

  const [row] = await db
    .insert(subtasks)
    .values({
      userId,
      taskId,
      title,
      sort: sql`(select coalesce(max(${subtasks.sort}) + 1, 0) from ${subtasks} where ${subtasks.userId} = ${userId} and ${subtasks.taskId} = ${taskId})`,
    })
    .returning();
  return row!;
}

export async function updateSubtask(
  userId: string,
  id: string,
  patch: { title?: string; done?: boolean },
): Promise<Subtask> {
  const values: Partial<typeof subtasks.$inferInsert> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.done !== undefined) values.done = patch.done;
  const where = and(eq(subtasks.userId, userId), eq(subtasks.id, id));
  const [row] =
    Object.keys(values).length > 0
      ? await db.update(subtasks).set(values).where(where).returning()
      : await db.select().from(subtasks).where(where);
  if (!row) throw new NotFoundError("subtask");
  return row;
}

export async function deleteSubtask(userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(subtasks)
    .where(and(eq(subtasks.userId, userId), eq(subtasks.id, id)))
    .returning({ id: subtasks.id });
  if (deleted.length === 0) throw new NotFoundError("subtask");
}
