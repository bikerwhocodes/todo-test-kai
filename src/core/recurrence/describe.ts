/**
 * Human-readable summaries of recurrence rules, for the Recurring pages and forms.
 *
 * Pure display helpers: no I/O, safe to import from client and server code. They
 * never throw, so a half-filled form can be previewed as the user types.
 */

import type { IsoDate } from "../dates";

/** The parts of a rule a summary needs; matches both RecurrenceRule and the stored series row. */
export type RuleSummaryInput = {
  kind: "daily" | "weekly";
  interval: number;
  /** 0 = Sunday … 6 = Saturday. Order and duplicates are ignored. */
  weekdays?: readonly number[] | null;
  endDate?: IsoDate | null;
};

/** Short weekday names, indexed 0 = Sunday … 6 = Saturday. */
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Display order: weeks start on Monday, matching the recurrence generator. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const WORKDAYS = "1,2,3,4,5";
const WEEKEND = "0,6";

/**
 * "Every day", "Every 3 days", "Every week on Mon", "Every 2 weeks on Mon, Wed",
 * "Every weekday", "Every 2 weeks on weekends".
 */
export function describeRule(rule: RuleSummaryInput): string {
  const n = Number.isInteger(rule.interval) && rule.interval > 1 ? rule.interval : 1;

  if (rule.kind === "daily") return n === 1 ? "Every day" : `Every ${n} days`;

  const days = WEEKDAY_ORDER.filter((d) => rule.weekdays?.includes(d));
  const every = n === 1 ? "Every week" : `Every ${n} weeks`;
  if (days.length === 0) return every;
  if (days.length === 7) return n === 1 ? "Every day" : `${every} on every day`;

  const key = [...days].sort((a, b) => a - b).join(",");
  if (key === WORKDAYS) return n === 1 ? "Every weekday" : `${every} on weekdays`;
  if (key === WEEKEND) return n === 1 ? "Every weekend" : `${every} on weekends`;
  return `${every} on ${days.map((d) => WEEKDAY_SHORT[d]).join(", ")}`;
}

/** "Ends 31 Dec", "Ends 31 Dec 2027", "Ended 3 Oct"; null when the rule has no end date. */
export function describeEnd(endDate: IsoDate | null | undefined, today: IsoDate): string | null {
  if (!endDate) return null;
  return `${endDate < today ? "Ended" : "Ends"} ${formatDayMonth(endDate, today)}`;
}

/** "31 Dec" in the same year as `today`, "31 Dec 2027" otherwise. Formatted in UTC so it never shifts. */
export function formatDayMonth(date: IsoDate, today: IsoDate): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
