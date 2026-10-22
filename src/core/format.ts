// Pure display helpers: no I/O, safe to import from client and server code.

/** 45 -> "45m", 60 -> "1h", 90 -> "1h 30m". */
export function formatEstimate(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "P1".."P3", or null for priority 4 ("none"). */
export function formatPriority(priority: number): string | null {
  return priority >= 1 && priority <= 3 ? `P${priority}` : null;
}

/** The calendar date (YYYY-MM-DD) that `instant` falls on in `timeZone`. */
export function isoDateInTimeZone(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** Whole days from `today` to `date`, both floating YYYY-MM-DD dates. */
export function daysBetween(today: string, date: string): number {
  return Math.round((isoToUtcMs(date) - isoToUtcMs(today)) / 86_400_000);
}

/**
 * Formats a floating deadline relative to `today` (both YYYY-MM-DD):
 * "Today", "Tomorrow", "Yesterday", "Fri 7 Nov", or "7 Nov 2027" in another year.
 * Formatting happens in UTC so the date never shifts with the viewer's zone.
 */
export function formatDeadline(deadline: string, today: string): string {
  const diff = daysBetween(today, deadline);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const sameYear = deadline.slice(0, 4) === today.slice(0, 4);
  const parts: Intl.DateTimeFormatOptions = sameYear
    ? { weekday: "short", day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...parts }).format(new Date(isoToUtcMs(deadline)));
}

/**
 * Explains why a new "waits on" link was refused. `titles` is the loop it would
 * close, first task repeated at the end (see core/graph cyclePath):
 * ["A", "B", "A"] -> 'That would create a loop: "A" waits on "B", which waits on "A".'
 */
export function formatLoopMessage(titles: readonly string[]): string {
  const q = (title: string) => `"${title}"`;
  if (titles.length <= 2) return `That would create a loop: ${q(titles[0] ?? "This task")} would wait on itself.`;
  const [first, second, ...rest] = titles;
  const tail = rest.map((t) => `, which waits on ${q(t)}`).join("");
  return `That would create a loop: ${q(first!)} waits on ${q(second!)}${tail}.`;
}

/** Badge text for a task waiting on open blockers: "Waiting on A", "Waiting on A and 2 more". */
export function formatWaitingOn(titles: readonly string[]): string {
  const [first, ...rest] = titles;
  if (first === undefined) return "";
  return rest.length === 0 ? `Waiting on ${first}` : `Waiting on ${first} and ${rest.length} more`;
}
