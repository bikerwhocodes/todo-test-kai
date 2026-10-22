import "server-only";
import { and, asc, eq, exists, ilike, isNotNull, isNull, lt, not, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { IsoDate } from "@/core/dates";
import { SEARCH_LIMIT, escapeLike, type SearchQuery } from "@/core/search";
import { db } from "@/server/db";
import { taskDependencies, tasks } from "@/server/db/schema";
import { withSubtasksAndBlockers, type TaskWithSubtasks } from "./tasks";

// Every function takes userId first and scopes every query by it.

export type SearchResult = { tasks: TaskWithSubtasks[]; truncated: boolean };

const blocker = alias(tasks, "blocker");

/**
 * The user's tasks matching every filter in `query` (see core/search), open
 * first, then by priority, deadline (none last) and age. At most SEARCH_LIMIT
 * rows; `truncated` says there were more. `today` is the user's local date,
 * for "overdue". A project id that isn't the user's simply matches nothing.
 */
export async function searchTasks(userId: string, query: SearchQuery, today: IsoDate): Promise<SearchResult> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), ...filters(userId, query, today)))
    .orderBy(
      sql`(${tasks.status} <> 'open')`,
      asc(tasks.priority),
      sql`${tasks.deadline} asc nulls last`,
      asc(tasks.createdAt),
      asc(tasks.id),
    )
    .limit(SEARCH_LIMIT + 1);
  const truncated = rows.length > SEARCH_LIMIT;
  return { tasks: await withSubtasksAndBlockers(userId, rows.slice(0, SEARCH_LIMIT)), truncated };
}

function filters(userId: string, query: SearchQuery, today: IsoDate): SQL[] {
  const where: SQL[] = [];

  if (query.q !== "") {
    // One substring, wildcards in the user's text matched literally.
    const pattern = `%${escapeLike(query.q)}%`;
    where.push(or(ilike(tasks.title, pattern), ilike(sql`coalesce(${tasks.description}, '')`, pattern))!);
  }

  if (query.project === "inbox") where.push(isNull(tasks.projectId));
  else if (query.project !== null) where.push(eq(tasks.projectId, query.project));

  if (query.priority !== null) where.push(eq(tasks.priority, query.priority));

  if (query.status !== "all") where.push(eq(tasks.status, query.status));

  if (query.due === "overdue") where.push(and(eq(tasks.status, "open"), lt(tasks.deadline, today))!);
  else if (query.due === "has") where.push(isNotNull(tasks.deadline));
  else if (query.due === "none") where.push(isNull(tasks.deadline));

  if (query.blocked !== null) {
    // Same rule as core/graph blockedSet, plus the task itself must be open.
    const isBlocked = and(eq(tasks.status, "open"), exists(openBlockerOf(userId)))!;
    where.push(query.blocked ? isBlocked : not(isBlocked));
  }

  if (query.estimate === true) where.push(isNotNull(tasks.estimateMin));
  else if (query.estimate === false) where.push(isNull(tasks.estimateMin));

  return where;
}

/** Correlated subquery: a direct blocker of the outer `tasks` row that is still open. */
function openBlockerOf(userId: string) {
  return db
    .select({ one: sql`1` })
    .from(taskDependencies)
    .innerJoin(blocker, and(eq(blocker.userId, taskDependencies.userId), eq(blocker.id, taskDependencies.blockedByTaskId)))
    .where(
      and(
        eq(taskDependencies.userId, userId),
        eq(taskDependencies.taskId, tasks.id),
        eq(blocker.userId, userId),
        eq(blocker.status, "open"),
      ),
    );
}
