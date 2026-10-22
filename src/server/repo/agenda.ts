import "server-only";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { UPCOMING_DAYS, upcomingEnd } from "@/core/agenda";
import { assertIsoDate, type IsoDate } from "@/core/dates";
import { db } from "@/server/db";
import { tasks } from "@/server/db/schema";
import { withSubtasksAndBlockers, type TaskWithSubtasks } from "./tasks";

// Every function takes userId first and scopes every query by it. `today` is the
// user's local date (core/dates localToday); deadlines are compared as dates in SQL.
// Results are ordered by deadline, then the usual task order; core/agenda groups them.

/** Open tasks with a deadline on or before the last day of Upcoming (overdue included). */
export async function listUpcomingTasks(
  userId: string,
  today: IsoDate,
  days = UPCOMING_DAYS,
): Promise<TaskWithSubtasks[]> {
  return listOpenDueBy(userId, upcomingEnd(today, days));
}

/** Open tasks due today or overdue. */
export async function listDueTasks(userId: string, today: IsoDate): Promise<TaskWithSubtasks[]> {
  assertIsoDate(today, "today");
  return listOpenDueBy(userId, today);
}

async function listOpenDueBy(userId: string, lastDate: IsoDate): Promise<TaskWithSubtasks[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.userId, userId), eq(tasks.status, "open"), isNotNull(tasks.deadline), lte(tasks.deadline, lastDate)),
    )
    .orderBy(asc(tasks.deadline), asc(tasks.sort), asc(tasks.createdAt), asc(tasks.id));
  return withSubtasksAndBlockers(userId, rows);
}
