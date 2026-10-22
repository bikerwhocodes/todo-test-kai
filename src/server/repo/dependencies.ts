import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { formatLoopMessage } from "@/core/format";
import { cyclePath, wouldCreateCycle } from "@/core/graph";
import { db } from "@/server/db";
import { taskDependencies, tasks, type TaskStatus } from "@/server/db/schema";
import { DependencyCycleError, NotFoundError } from "./errors";

// Every function takes userId first and scopes every query by it.
// An edge (taskId, blockedByTaskId) reads "taskId is blocked by blockedByTaskId".

/** A task's direct blocker. It blocks only while its status is "open". */
export type Blocker = { id: string; title: string; status: TaskStatus };

/**
 * First key of pg_advisory_xact_lock(int, int), reserving a namespace for
 * "the dependency graph of one user"; the second key is hashtext(user_id).
 * A hash collision between two users only makes them wait for each other.
 */
const GRAPH_LOCK_NS = 0x64657073; // "deps"

/** The direct blockers of each of `taskIds`, in the order they were added. One query. */
export async function blockersFor(userId: string, taskIds: string[]): Promise<Map<string, Blocker[]>> {
  const map = new Map<string, Blocker[]>();
  if (taskIds.length === 0) return map;
  const rows = await db
    .select({ taskId: taskDependencies.taskId, id: tasks.id, title: tasks.title, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(
      tasks,
      and(eq(tasks.userId, taskDependencies.userId), eq(tasks.id, taskDependencies.blockedByTaskId)),
    )
    .where(and(eq(taskDependencies.userId, userId), inArray(taskDependencies.taskId, taskIds)))
    .orderBy(asc(taskDependencies.createdAt), asc(tasks.id));
  for (const { taskId, ...blocker } of rows) {
    const list = map.get(taskId);
    if (list) list.push(blocker);
    else map.set(taskId, [blocker]);
  }
  return map;
}

/**
 * Makes `taskId` wait on `blockedByTaskId`. Both must be the user's tasks
 * (NotFoundError otherwise, checked before anything else so another user's
 * graph can't be probed). Throws DependencyCycleError, saving nothing, if the
 * link would close a loop. Adding a link that already exists is a no-op.
 */
export async function addBlocker(userId: string, taskId: string, blockedByTaskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Without this, two concurrent adds ("A waits on B" and "B waits on A") would
    // each read a graph with no loop and both commit one. Holding a per-user lock
    // from before the edges are read until commit serializes every add for a user.
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(GRAPH_LOCK_NS))}, hashtext(${userId}))`);

    // KEY SHARE keeps both tasks from being deleted before the insert commits.
    const ids = [...new Set([taskId, blockedByTaskId])];
    const found = await tx
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)))
      .for("key share");
    if (found.length !== ids.length) throw new NotFoundError("task");

    const edges = await tx
      .select({ taskId: taskDependencies.taskId, blockedById: taskDependencies.blockedByTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.userId, userId));

    if (wouldCreateCycle(edges, taskId, blockedByTaskId)) {
      const loop = cyclePath(edges, taskId, blockedByTaskId) ?? [taskId, blockedByTaskId, taskId];
      const titles = new Map(
        (
          await tx
            .select({ id: tasks.id, title: tasks.title })
            .from(tasks)
            .where(and(eq(tasks.userId, userId), inArray(tasks.id, [...new Set(loop)])))
        ).map((t) => [t.id, t.title]),
      );
      throw new DependencyCycleError(formatLoopMessage(loop.map((id) => titles.get(id) ?? "another task")));
    }

    await tx.insert(taskDependencies).values({ userId, taskId, blockedByTaskId }).onConflictDoNothing();
  });
}

/**
 * Stops `taskId` waiting on `blockedByTaskId`. Both must be the user's tasks
 * (NotFoundError otherwise); removing a link that isn't there is a no-op.
 */
export async function removeBlocker(userId: string, taskId: string, blockedByTaskId: string): Promise<void> {
  const ids = [...new Set([taskId, blockedByTaskId])];
  const found = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)));
  if (found.length !== ids.length) throw new NotFoundError("task");

  await db
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.userId, userId),
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.blockedByTaskId, blockedByTaskId),
      ),
    );
}
