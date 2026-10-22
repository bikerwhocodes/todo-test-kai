import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { subtasks, type Subtask } from "../db/schema";
import { pick, rethrowForeignKey } from "./errors";

export type NewSubtask = { title: string; sort?: number };
const PATCH_KEYS = ["title", "done", "sort"] as const;
export type SubtaskPatch = Partial<Pick<Subtask, (typeof PATCH_KEYS)[number]>>;

const FK = { subtasks_user_task_fk: "task" };

export function subtasksRepo(db: Db) {
  const owned = (userId: string, id: string) =>
    and(eq(subtasks.userId, userId), eq(subtasks.id, id));

  return {
    async listForTask(userId: string, taskId: string): Promise<Subtask[]> {
      return db
        .select()
        .from(subtasks)
        .where(and(eq(subtasks.userId, userId), eq(subtasks.taskId, taskId)))
        .orderBy(asc(subtasks.sort), asc(subtasks.createdAt));
    },

    /** Throws NotFoundError if taskId is not one of the user's tasks. */
    async create(userId: string, taskId: string, input: NewSubtask): Promise<Subtask> {
      try {
        const [row] = await db
          .insert(subtasks)
          .values({ ...pick(input, ["title", "sort"]), userId, taskId })
          .returning();
        return row!;
      } catch (err) {
        rethrowForeignKey(err, FK);
      }
    },

    async update(userId: string, id: string, patch: SubtaskPatch): Promise<Subtask | null> {
      const values = pick(patch, PATCH_KEYS);
      if (Object.keys(values).length === 0) {
        const [row] = await db.select().from(subtasks).where(owned(userId, id));
        return row ?? null;
      }
      const [row] = await db.update(subtasks).set(values).where(owned(userId, id)).returning();
      return row ?? null;
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const deleted = await db
        .delete(subtasks)
        .where(owned(userId, id))
        .returning({ id: subtasks.id });
      return deleted.length > 0;
    },
  };
}
