/**
 * Date-based task views: Upcoming and Today's "due, not in plan" section.
 *
 * Pure: callers pass `today` (the user's `localToday(tz, now)`). Deadlines are
 * floating `IsoDate` strings and are only ever compared as dates, never turned
 * into instants, so no zone (the server's or the viewer's) can shift them.
 * "Overdue" means `deadline < today` and nothing else.
 */

import { addDays, assertIsoDate, compareIsoDate, diffDays, weekdayOf, type IsoDate } from "./dates";

/** Upcoming covers today plus the next 13 days. */
export const UPCOMING_DAYS = 14;

/** The fields these views read; repo rows and test fixtures both fit. */
export type AgendaTask = { id: string; deadline: IsoDate | null; status: string };

/** A task known to have a deadline. */
export type Dated<T extends AgendaTask> = T & { deadline: IsoDate };

export type DayGroup<T extends AgendaTask> = { date: IsoDate; tasks: Dated<T>[] };
export type UpcomingGroups<T extends AgendaTask> = { overdue: Dated<T>[]; days: DayGroup<T>[] };

/** The last date Upcoming shows: `today + days - 1`. */
export function upcomingEnd(today: IsoDate, days = UPCOMING_DAYS): IsoDate {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`upcomingEnd: days must be a positive integer, got ${days}`);
  }
  return addDays(today, days - 1);
}

/** Open tasks that have a deadline, oldest deadline first; ties keep their input order. */
function openWithDeadline<T extends AgendaTask>(tasks: readonly T[]): Dated<T>[] {
  return tasks
    .filter((t): t is Dated<T> => t.status === "open" && t.deadline !== null)
    .sort((a, b) => compareIsoDate(a.deadline, b.deadline));
}

/**
 * Upcoming: open tasks due before `today` go in `overdue` (oldest first); the rest,
 * up to and including `upcomingEnd(today, days)`, are grouped by deadline in date
 * order. Only dates with tasks get a group. Later deadlines and tasks without one
 * are left out.
 */
export function groupUpcoming<T extends AgendaTask>(
  tasks: readonly T[],
  today: IsoDate,
  days = UPCOMING_DAYS,
): UpcomingGroups<T> {
  const end = upcomingEnd(today, days);
  const overdue: Dated<T>[] = [];
  const groups: DayGroup<T>[] = [];
  for (const task of openWithDeadline(tasks)) {
    if (compareIsoDate(task.deadline, today) < 0) overdue.push(task);
    else if (compareIsoDate(task.deadline, end) <= 0) {
      const last = groups.at(-1);
      if (last?.date === task.deadline) last.tasks.push(task);
      else groups.push({ date: task.deadline, tasks: [task] });
    }
  }
  return { overdue, days: groups };
}

/**
 * Today's "due today & overdue, not in plan" section: open tasks with
 * `deadline <= today` that aren't in the plan, overdue first (oldest deadline
 * first), then those due today.
 */
export function dueNotInPlan<T extends AgendaTask>(
  tasks: readonly T[],
  today: IsoDate,
  plannedIds: Iterable<string>,
): Dated<T>[] {
  const planned = new Set(plannedIds);
  return openWithDeadline(tasks).filter((t) => compareIsoDate(t.deadline, today) <= 0 && !planned.has(t.id));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * "Thu 22 Oct", with the year added when it differs from `today`'s ("Fri 1 Jan 2027").
 * Built from the date's own fields, so there is no Date and no zone to drift.
 */
export function formatShortDate(date: IsoDate, today: IsoDate): string {
  assertIsoDate(date);
  assertIsoDate(today, "today");
  const label = `${WEEKDAYS[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
  return date.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${Number(date.slice(0, 4))}`;
}

/** Upcoming group heading: "Today · Thu 22 Oct", "Tomorrow · Fri 23 Oct", then "Sat 24 Oct". */
export function formatDayHeading(date: IsoDate, today: IsoDate): string {
  const short = formatShortDate(date, today);
  const diff = diffDays(today, date);
  if (diff === 0) return `Today · ${short}`;
  if (diff === 1) return `Tomorrow · ${short}`;
  return short;
}

/** "1 day overdue", "12 days overdue"; null unless `deadline` is before `today`. */
export function formatOverdue(deadline: IsoDate, today: IsoDate): string | null {
  const days = diffDays(deadline, today);
  if (days <= 0) return null;
  return days === 1 ? "1 day overdue" : `${days} days overdue`;
}
