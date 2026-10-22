import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import { projects, type Project } from "@/server/db/schema";
import { NotFoundError } from "./errors";

// Every function takes userId first and scopes every query by it.

export async function listProjects(
  userId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), includeArchived ? undefined : isNull(projects.archivedAt)))
    .orderBy(asc(projects.sort), asc(projects.createdAt), asc(projects.id));
}

export async function getProject(userId: string, id: string): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.id, id)));
  return row ?? null;
}

/** Throws NotFoundError unless `id` is one of the user's active (unarchived) projects. */
export async function assertActiveProject(userId: string, id: string): Promise<void> {
  const project = await getProject(userId, id);
  if (!project || project.archivedAt) throw new NotFoundError("project");
}

export async function createProject(userId: string, { name }: { name: string }): Promise<Project> {
  const [row] = await db.insert(projects).values({ userId, name }).returning();
  return row!;
}

export async function renameProject(userId: string, id: string, name: string): Promise<Project> {
  const [row] = await db
    .update(projects)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(projects.userId, userId), eq(projects.id, id)))
    .returning();
  if (!row) throw new NotFoundError("project");
  return row;
}

/** Archiving keeps the project and its tasks; it only hides it from lists and pickers. */
export async function setProjectArchived(userId: string, id: string, archived: boolean): Promise<Project> {
  const [row] = await db
    .update(projects)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(projects.userId, userId), eq(projects.id, id)))
    .returning();
  if (!row) throw new NotFoundError("project");
  return row;
}
