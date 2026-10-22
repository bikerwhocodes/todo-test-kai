/**
 * Recurrence generator for floating dates (spec §8).
 *
 * MVP rules only: "every N days" and "every N weeks on these weekdays", with an
 * optional inclusive end date. A small generator instead of an RRULE engine:
 * all arithmetic is on `IsoDate` day numbers, so DST can't skip or repeat a date.
 *
 * The series is a fixed schedule anchored at `startDate` (Todoist's `every`,
 * not `every!`): completing late never shifts later occurrences, it only
 * skips the ones already in the past.
 */

import {
  type IsoDate,
  type Weekday,
  assertIsoDate,
  compareIsoDate,
  fromDayNumber,
  maxIsoDate,
  startOfIsoWeek,
  toDayNumber,
} from "../dates";

/** Upper bound on `interval`; keeps rules sane and arithmetic cheap. */
export const MAX_INTERVAL = 365;

export interface DailyRule {
  kind: "daily";
  /** Every N days, N ≥ 1. */
  interval: number;
  /** First possible occurrence (inclusive). */
  startDate: IsoDate;
  /** Last possible occurrence (inclusive). `null`/absent = no end. */
  endDate?: IsoDate | null;
}

export interface WeeklyRule {
  kind: "weekly";
  /** Every N weeks, N ≥ 1. Weeks start on Monday; week 0 is the week containing `startDate`. */
  interval: number;
  /** Non-empty set of weekdays (0 = Sunday … 6 = Saturday). Order and duplicates are ignored. */
  weekdays: readonly Weekday[];
  startDate: IsoDate;
  endDate?: IsoDate | null;
}

export type RecurrenceRule = DailyRule | WeeklyRule;

/** Returns a list of problems with `rule`; empty when valid. Use for user-facing validation. */
export function validateRule(rule: RecurrenceRule): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL) {
    errors.push(`interval must be an integer from 1 to ${MAX_INTERVAL}`);
  }
  let startOk = true;
  try {
    assertIsoDate(rule.startDate, "startDate");
  } catch (e) {
    startOk = false;
    errors.push((e as Error).message);
  }
  if (rule.endDate != null) {
    try {
      assertIsoDate(rule.endDate, "endDate");
      if (startOk && compareIsoDate(rule.endDate, rule.startDate) < 0) {
        errors.push("endDate must be on or after startDate");
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (rule.kind === "weekly") {
    if (!Array.isArray(rule.weekdays) || rule.weekdays.length === 0) {
      errors.push("weekly rule needs at least one weekday");
    } else if (!rule.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      errors.push("weekdays must be integers 0 (Sunday) to 6 (Saturday)");
    }
  } else if (rule.kind !== "daily") {
    errors.push(`unknown rule kind ${JSON.stringify((rule as { kind: unknown }).kind)}`);
  }
  return errors;
}

function assertValidRule(rule: RecurrenceRule): void {
  const errors = validateRule(rule);
  if (errors.length > 0) throw new RangeError(`Invalid recurrence rule: ${errors.join("; ")}`);
}

/** Smallest occurrence day number ≥ `from` (a day number), ignoring endDate. */
function occurrenceOnOrAfter(rule: RecurrenceRule, from: number): number {
  const start = toDayNumber(rule.startDate);
  const target = Math.max(from, start);

  if (rule.kind === "daily") {
    const steps = Math.ceil((target - start) / rule.interval);
    return start + steps * rule.interval;
  }

  // Weekly: weeks are Monday-based, numbered from the week containing startDate.
  const days = new Set<number>(rule.weekdays.map((d) => (d + 6) % 7)); // 0 = Monday … 6 = Sunday
  const week0 = toDayNumber(startOfIsoWeek(rule.startDate));
  let weekIndex = Math.floor((target - week0) / 7);
  // Round up to the next active week (every `interval`-th week).
  const rem = weekIndex % rule.interval;
  let offsetInWeek = target - (week0 + weekIndex * 7);
  if (rem !== 0) {
    weekIndex += rule.interval - rem;
    offsetInWeek = 0;
  }
  // At most two active weeks are ever inspected: the current one, then the next.
  for (;;) {
    const weekStart = week0 + weekIndex * 7;
    for (let i = offsetInWeek; i < 7; i++) {
      if (days.has(i)) return weekStart + i;
    }
    weekIndex += rule.interval;
    offsetInWeek = 0;
  }
}

function withinEnd(rule: RecurrenceRule, day: number): IsoDate | null {
  const date = fromDayNumber(day);
  if (rule.endDate != null && compareIsoDate(date, rule.endDate) > 0) return null;
  return date;
}

/**
 * The first date of the series: the earliest matching date on or after `startDate`.
 *
 * Note that for weekly rules this need not be `startDate` itself
 * (e.g. start on a Wednesday, weekdays = [Mon] → the following Monday).
 *
 * @returns `null` if the series has no occurrence on or before `endDate`.
 * @throws RangeError if the rule is invalid (see `validateRule`).
 */
export function firstOccurrence(rule: RecurrenceRule): IsoDate | null {
  assertValidRule(rule);
  return withinEnd(rule, occurrenceOnOrAfter(rule, toDayNumber(rule.startDate)));
}

/**
 * The earliest occurrence strictly after `after`.
 *
 * When generating the next occurrence on completion, pass
 * `after = maxIsoDate(occurrenceDate, today)` (or use `nextOccurrenceAfterCompletion`)
 * so the new date is always in the future and never duplicates an existing one.
 *
 * @returns `null` when the series has ended (next date would be after `endDate`).
 * @throws RangeError if the rule or `after` is invalid.
 */
export function nextOccurrence(rule: RecurrenceRule, after: IsoDate): IsoDate | null {
  assertValidRule(rule);
  assertIsoDate(after, "after");
  return withinEnd(rule, occurrenceOnOrAfter(rule, toDayNumber(after) + 1));
}

/**
 * The next open occurrence to create when the occurrence on `occurrenceDate` is
 * completed on `today` (the user's `localToday`). Always > max(occurrenceDate, today);
 * overdue occurrences that were skipped are not back-filled.
 */
export function nextOccurrenceAfterCompletion(
  rule: RecurrenceRule,
  occurrenceDate: IsoDate,
  today: IsoDate,
): IsoDate | null {
  return nextOccurrence(rule, maxIsoDate(occurrenceDate, today));
}

/**
 * All occurrences in `[from, to]` (inclusive), capped at `limit` results.
 * Useful for previews ("next 5 dates") and tests.
 */
export function occurrencesBetween(
  rule: RecurrenceRule,
  from: IsoDate,
  to: IsoDate,
  limit = 1000,
): IsoDate[] {
  assertValidRule(rule);
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  const out: IsoDate[] = [];
  const toDay = toDayNumber(to);
  let day = occurrenceOnOrAfter(rule, toDayNumber(from));
  while (day <= toDay && out.length < limit) {
    const date = withinEnd(rule, day);
    if (date === null) break;
    out.push(date);
    day = occurrenceOnOrAfter(rule, day + 1);
  }
  return out;
}

/**
 * The earliest occurrence on or after `date` (and on or after `startDate`).
 * Used when a series is created or its rule is edited.
 *
 * @returns `null` when the series has ended by then.
 */
export function occurrenceOnOrAfterDate(rule: RecurrenceRule, date: IsoDate): IsoDate | null {
  assertValidRule(rule);
  assertIsoDate(date, "date");
  return withinEnd(rule, occurrenceOnOrAfter(rule, toDayNumber(date)));
}

/**
 * How many scheduled dates have passed while the occurrence on `occurrenceDate`
 * stayed open: the occurrences in `[occurrenceDate, today)`. 0 when it is due today
 * or later. Nothing is back-filled; this only feeds the "missed N days" label.
 */
export function missedOccurrences(rule: RecurrenceRule, occurrenceDate: IsoDate, today: IsoDate): number {
  assertIsoDate(today, "today");
  if (compareIsoDate(occurrenceDate, today) >= 0) return 0;
  return occurrencesBetween(rule, occurrenceDate, fromDayNumber(toDayNumber(today) - 1), MISSED_CAP).length;
}

/** Upper bound for `missedOccurrences`; the label shows "99+" beyond it. */
export const MISSED_CAP = 100;

/** "Missed 5 days" for daily rules, "Missed 2 times" for weekly ones; null when nothing was missed. */
export function missedLabel(kind: RecurrenceRule["kind"], missed: number): string | null {
  if (missed <= 0) return null;
  const n = missed >= MISSED_CAP ? `${MISSED_CAP - 1}+` : String(missed);
  const unit = kind === "daily" ? (missed === 1 ? "day" : "days") : missed === 1 ? "time" : "times";
  return `Missed ${n} ${unit}`;
}
