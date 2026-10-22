// Floating calendar dates as ISO "YYYY-MM-DD" strings. Pure: callers pass `now`
// and the IANA time zone; nothing here reads the clock or the environment.
// Arithmetic happens on UTC midnights, so DST transitions can never shift a date.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True when `value` is a real calendar date in YYYY-MM-DD form (2028-02-29 yes, 2027-02-29 no). */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function toUtcMs(iso: string): number {
  if (!isIsoDate(iso)) throw new RangeError(`Not an ISO date: ${iso}`);
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The calendar date the instant `now` falls on in `timeZone` (an IANA name). */
export function localToday(timeZone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** `iso` shifted by `days` (may be negative). */
export function addDays(iso: string, days: number): string {
  return fromUtcMs(toUtcMs(iso) + days * DAY_MS);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** ISO weekday of `iso`: 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: string): number {
  const day = new Date(toUtcMs(iso)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The first date strictly after `today` that falls on ISO `weekday` (1..7): 1 to 7 days ahead. */
export function nextWeekday(today: string, weekday: number): string {
  const ahead = (weekday - isoWeekday(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}
