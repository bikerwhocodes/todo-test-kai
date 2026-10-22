/**
 * Floating calendar dates (spec §7).
 *
 * Every date in NextUp's domain is a plain `YYYY-MM-DD` string with no time
 * and no zone. Arithmetic is done on a day number (days since 1970-01-01 in the
 * proleptic Gregorian calendar) so DST, leap seconds and the host time zone can
 * never shift a date. The only place a zone matters is `localToday`, which turns
 * an injected instant into the user's wall-clock date.
 *
 * This module never reads the clock or the environment.
 */

/** A calendar date formatted as `YYYY-MM-DD` (years 0001–9999). */
export type IsoDate = string;

/** Day of week, 0 = Sunday … 6 = Saturday (same as `Date#getUTCDay` and Postgres `EXTRACT(DOW)`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** True if `value` is a real calendar date in `YYYY-MM-DD` form (rejects 2026-02-29, 2026-13-01, …). */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Throws a `RangeError` unless `value` is a valid `IsoDate`. */
export function assertIsoDate(value: unknown, label = "date"): asserts value is IsoDate {
  if (!isIsoDate(value)) {
    throw new RangeError(`Invalid ${label}: expected YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
}

/** Days since 1970-01-01 (Howard Hinnant's days_from_civil). */
export function toDayNumber(date: IsoDate): number {
  assertIsoDate(date);
  const y0 = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of `toDayNumber` (Howard Hinnant's civil_from_days). */
export function fromDayNumber(dayNumber: number): IsoDate {
  if (!Number.isSafeInteger(dayNumber)) {
    throw new RangeError(`Invalid day number: ${dayNumber}`);
  }
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  if (y < 1 || y > 9999) {
    throw new RangeError(`Date out of supported range (0001–9999): day number ${dayNumber}`);
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new RangeError(`addDays: days must be an integer, got ${days}`);
  return fromDayNumber(toDayNumber(date) + days);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

export function weekdayOf(date: IsoDate): Weekday {
  // 1970-01-01 was a Thursday (4).
  return (((toDayNumber(date) + 4) % 7) + 7) % 7 as Weekday;
}

/** The Monday on or before `date`. Weeks start on Monday (ISO 8601). */
export function startOfIsoWeek(date: IsoDate): IsoDate {
  const n = toDayNumber(date);
  const daysSinceMonday = (weekdayOf(date) + 6) % 7;
  return fromDayNumber(n - daysSinceMonday);
}

/** -1, 0 or 1. Validated `IsoDate`s sort correctly as strings. */
export function compareIsoDate(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  assertIsoDate(a);
  assertIsoDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxIsoDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareIsoDate(a, b) >= 0 ? a : b;
}

export function minIsoDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareIsoDate(a, b) <= 0 ? a : b;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    // Throws RangeError for unknown zones.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      calendar: "gregory",
      numberingSystem: "latn",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** True if `tz` is an IANA zone name the runtime recognises. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * The user's calendar date at instant `now` in IANA zone `tz`.
 *
 * `now` is injected; this never reads the clock.
 *
 * @example localToday("America/Los_Angeles", new Date("2026-11-01T06:30:00Z")) // "2026-10-31"
 * @example localToday("Asia/Tokyo",          new Date("2026-11-01T06:30:00Z")) // "2026-11-01"
 * @throws RangeError for an unknown zone or an invalid Date.
 */
export function localToday(tz: string, now: Date): IsoDate {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("localToday: now must be a valid Date");
  }
  if (typeof tz !== "string" || tz === "") {
    throw new RangeError(`localToday: invalid time zone ${JSON.stringify(tz)}`);
  }
  let year = "";
  let month = "";
  let day = "";
  for (const part of formatterFor(tz).formatToParts(now)) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  const date = `${year.padStart(4, "0")}-${month}-${day}`;
  assertIsoDate(date, "local date");
  return date;
}
