// Date boundaries of the Today and Upcoming views (spec §7). Pure: the caller passes
// the user's `today` (localToday of the profile zone), never a server-local date.

import { addDays, assertIsoDate, type IsoDate } from "./dates";

/** How many days after today the Upcoming view covers. */
export const UPCOMING_DAYS = 7;

/** Today shows everything dated on or before `today` (overdue included). */
export function todayCutoff(today: IsoDate): IsoDate {
  assertIsoDate(today, "today");
  return today;
}

/** Upcoming covers the inclusive range (today, today + days]. */
export function upcomingRange(today: IsoDate, days = UPCOMING_DAYS): { from: IsoDate; to: IsoDate } {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`Invalid upcoming days: expected a positive integer, got ${days}`);
  }
  return { from: addDays(today, 1), to: addDays(today, days) };
}
