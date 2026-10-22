import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { tasks, type Task } from "../db/schema";
import { pick, rethrowForeignKey } from "./errors";

export type NewTask = {
  title: string;
  projectId?: string | null;
  description?: string | null;
  priority?: number;
  deadline?: string | null;
  estimateMin?: number | null;
  sort?: number;
};
const FIELDS = [
  "title",
  "projectId",
  "description",
  "priority",
  "deadline",
  "estimateMin",
  "sort",
] as const;
export type TaskPatch = Partial<Pick<Task, (typeof FIELDS)[number]>>;

const FK = { tasks_user_project_fk: "project" };

export function tasksRepo(db: Db) {
  const owned = (userId: string, id: string) => and(eq(tasks.userId, userId), eq(tasks.id, id));
  const ordering = [asc(tasks.sort), asc(tasks.createdAt)];

  return {
    async get(userId: string, id: string): Promise<Task | null> {
      const [row] = await db.select().from(tasks).where(owned(userId, id));
      return row ?? null;
    },

    /** Open tasks without a project. */
    async listInbox(userId: string): Promise<Task[]> {
      return db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), isNull(tasks.projectId), eq(tasks.status, "open")))
        .orderBy(...ordering);
    },

    async listByProject(userId: string, projectId: string): Promise<Task[]> {
      return db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), eq(tasks.projectId, projectId)))
        .orderBy(...ordering);
    },

    /** Throws NotFoundError if projectId is not one of the user's projects. */
    async create(userId: string, input: NewTask): Promise<Task> {
      try {
        const [row] = await db
          .insert(tasks)
          .values({ ...pick(input, FIELDS), userId })
          .returning();
        return row!;
      } catch (err) {
        rethrowForeignKey(err, FK);
      }
    },

    /** Returns null if the task is not found; throws NotFoundError for a foreign projectId. */
    async update(userId: string, id: string, patch: TaskPatch): Promise<Task | null> {
      try {
        const [row] = await db
          .update(tasks)
          .set({ ...pick(patch, FIELDS), updatedAt: new Date() })
          .where(owned(userId, id))
          .returning();
        return row ?? null;
      } catch (err) {
        rethrowForeignKey(err, FK);
      }
    },

    async setStatus(userId: string, id: string, status: Task["status"]): Promise<Task | null> {
      const now = new Date();
      const [row] = await db
        .update(tasks)
        .set({ status, completedAt: status === "open" ? null : now, updatedAt: now })
        .where(owned(userId, id))
        .returning();
      return row ?? null;
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const deleted = await db.delete(tasks).where(owned(userId, id)).returning({ id: tasks.id });
      return deleted.length > 0;
    },
  };
}
