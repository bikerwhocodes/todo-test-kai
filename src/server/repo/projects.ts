import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, tasks, type Project } from "../db/schema";
import { pick } from "./errors";

export type NewProject = { name: string; color?: string | null; sort?: number };
const PATCH_KEYS = ["name", "color", "sort"] as const;
export type ProjectPatch = Partial<Pick<Project, (typeof PATCH_KEYS)[number]>>;

export function projectsRepo(db: Db) {
  const owned = (userId: string, id: string) =>
    and(eq(projects.userId, userId), eq(projects.id, id));

  return {
    async list(userId: string, opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
      return db
        .select()
        .from(projects)
        .where(
          opts.includeArchived
            ? eq(projects.userId, userId)
            : and(eq(projects.userId, userId), isNull(projects.archivedAt)),
        )
        .orderBy(asc(projects.sort), asc(projects.createdAt));
    },

    async get(userId: string, id: string): Promise<Project | null> {
      const [row] = await db.select().from(projects).where(owned(userId, id));
      return row ?? null;
    },

    async create(userId: string, input: NewProject): Promise<Project> {
      const [row] = await db
        .insert(projects)
        .values({ ...pick(input, ["name", "color", "sort"]), userId })
        .returning();
      return row!;
    },

    async update(userId: string, id: string, patch: ProjectPatch): Promise<Project | null> {
      const values = pick(patch, PATCH_KEYS);
      if (Object.keys(values).length === 0) {
        const [row] = await db.select().from(projects).where(owned(userId, id));
        return row ?? null;
      }
      const [row] = await db.update(projects).set(values).where(owned(userId, id)).returning();
      return row ?? null;
    },

    async setArchived(userId: string, id: string, archived: boolean): Promise<Project | null> {
      const [row] = await db
        .update(projects)
        .set({ archivedAt: archived ? new Date() : null })
        .where(owned(userId, id))
        .returning();
      return row ?? null;
    },

    /** Deletes the project; its tasks move to the Inbox. Returns false if not found. */
    async remove(userId: string, id: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({ projectId: null, updatedAt: new Date() })
          .where(and(eq(tasks.userId, userId), eq(tasks.projectId, id)));
        const deleted = await tx
          .delete(projects)
          .where(owned(userId, id))
          .returning({ id: projects.id });
        return deleted.length > 0;
      });
    },
  };
}
