import { addDays, isIsoDate, nextWeekday } from "../dates";

// Quick-add parser: "Fix build #Client A !p1 ~45m ^fri" -> title + optional fields.
//
// Grammar (tokens are case-insensitive and must start at the beginning of the
// text or after whitespace):
//   #<project>   longest existing project name, followed by whitespace or the end
//   !p1 .. !p4   priority (4 = none)
//   ~<n>m | ~<n>h | ~<n>h<m> | ~<n>h<m>m   estimate in minutes, 1..1440, <m> < 60
//   ^today | ^tomorrow | ^mon .. ^sun (or full names) | ^YYYY-MM-DD   deadline
//
// Anything not recognised stays in the title verbatim: unknown projects, malformed
// or out-of-range values, and every token of a kind that appears more than once
// (ambiguous). Weekdays mean the next such day strictly after `today`; use ^today
// for today. The parser never creates projects and never reads the clock.

export type QuickAddTokenKind = "project" | "priority" | "estimate" | "deadline";

/** A recognised token, as a [start, end) span of the input, for highlighting. */
export interface QuickAddToken {
  kind: QuickAddTokenKind;
  start: number;
  end: number;
  text: string;
}

export interface QuickAddProject {
  name: string;
}

export interface QuickAddInput<P extends QuickAddProject> {
  text: string;
  /** The user's local today (YYYY-MM-DD), e.g. from `localToday(tz, now)`. */
  today: string;
  /** The user's existing projects; `#` only matches these. */
  projects: readonly P[];
}

export interface QuickAddResult<P extends QuickAddProject> {
  /** Text with recognised tokens removed and whitespace collapsed. May be "": the caller validates. */
  title: string;
  project: P | null;
  priority: 1 | 2 | 3 | 4 | null;
  estimateMin: number | null;
  deadline: string | null;
  /** Recognised tokens in input order. */
  tokens: QuickAddToken[];
}

const MAX_ESTIMATE_MIN = 1440;

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
}; // prettier-ignore

interface Candidate<P> {
  token: QuickAddToken;
  value: P | number | string;
}

function parsePriority(word: string): number | null {
  const m = /^!p([1-4])$/i.exec(word);
  return m ? Number(m[1]) : null;
}

function parseEstimate(word: string): number | null {
  const m = /^~(?:(\d{1,4})m|(\d{1,2})h(?:(\d{1,2})m?)?)$/i.exec(word);
  if (!m) return null;
  let minutes: number;
  if (m[1] !== undefined) {
    minutes = Number(m[1]);
  } else {
    const extra = m[3] === undefined ? 0 : Number(m[3]);
    if (extra >= 60) return null;
    minutes = Number(m[2]) * 60 + extra;
  }
  return minutes >= 1 && minutes <= MAX_ESTIMATE_MIN ? minutes : null;
}

function parseDeadline(word: string, today: string): string | null {
  if (!word.startsWith("^")) return null;
  const value = word.slice(1).toLowerCase();
  if (value === "today") return today;
  if (value === "tomorrow") return addDays(today, 1);
  const weekday = WEEKDAYS[value];
  if (weekday !== undefined) return nextWeekday(today, weekday);
  return isIsoDate(value) ? value : null;
}

/**
 * The project named right after `#` at `start`: the longest name followed by
 * whitespace or the end. Names differing only by case resolve to the exact-case
 * match, or to nothing when none is exact.
 */
function matchProject<P extends QuickAddProject>(
  text: string,
  start: number,
  projects: readonly P[],
): { project: P; end: number } | null {
  const rest = text.slice(start + 1);
  const restLower = rest.toLowerCase();
  let best: P[] = [];
  let bestLen = 0;
  for (const p of projects) {
    const name = p.name.trim();
    if (name.length === 0 || name.length < bestLen) continue;
    if (!restLower.startsWith(name.toLowerCase())) continue;
    const next = rest.charAt(name.length);
    if (next !== "" && !/\s/.test(next)) continue;
    if (name.length > bestLen) {
      best = [p];
      bestLen = name.length;
    } else {
      best.push(p);
    }
  }
  if (best.length === 0) return null;
  const exact = best.length === 1 ? best : best.filter((p) => rest.startsWith(p.name.trim()));
  return exact.length === 1 ? { project: exact[0]!, end: start + 1 + bestLen } : null;
}

export function parseQuickAdd<P extends QuickAddProject>(
  input: QuickAddInput<P>,
): QuickAddResult<P> {
  const { text, today, projects } = input;
  const candidates = new Map<QuickAddTokenKind, Candidate<P>[]>();
  const add = (kind: QuickAddTokenKind, start: number, end: number, value: P | number | string) => {
    const list = candidates.get(kind) ?? [];
    list.push({ token: { kind, start, end, text: text.slice(start, end) }, value });
    candidates.set(kind, list);
  };

  // Walk whitespace-separated words; `#` may consume several words.
  const word = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = word.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    switch (m[0][0]) {
      case "#": {
        const hit = matchProject(text, start, projects);
        if (hit) {
          add("project", start, hit.end, hit.project);
          word.lastIndex = hit.end;
        }
        break;
      }
      case "!": {
        const priority = parsePriority(m[0]);
        if (priority !== null) add("priority", start, end, priority);
        break;
      }
      case "~": {
        const estimate = parseEstimate(m[0]);
        if (estimate !== null) add("estimate", start, end, estimate);
        break;
      }
      case "^": {
        const deadline = parseDeadline(m[0], today);
        if (deadline !== null) add("deadline", start, end, deadline);
        break;
      }
    }
  }

  // A kind seen more than once is ambiguous: none of its tokens apply.
  const single = (kind: QuickAddTokenKind) => {
    const list = candidates.get(kind);
    return list?.length === 1 ? list[0]! : null;
  };
  const project = single("project");
  const priority = single("priority");
  const estimate = single("estimate");
  const deadline = single("deadline");
  const tokens = [project, priority, estimate, deadline]
    .filter((c): c is Candidate<P> => c !== null)
    .map((c) => c.token)
    .sort((a, b) => a.start - b.start);

  let title = "";
  let cursor = 0;
  for (const t of tokens) {
    title += text.slice(cursor, t.start) + " ";
    cursor = t.end;
  }
  title = (title + text.slice(cursor)).replace(/\s+/g, " ").trim();

  return {
    title,
    project: (project?.value as P | undefined) ?? null,
    priority: (priority?.value as 1 | 2 | 3 | 4 | undefined) ?? null,
    estimateMin: (estimate?.value as number | undefined) ?? null,
    deadline: (deadline?.value as string | undefined) ?? null,
    tokens,
  };
}

/** Splits `text` into plain and token segments, in order, for rendering highlights. */
export function quickAddSegments(
  text: string,
  tokens: readonly QuickAddToken[],
): { text: string; kind: QuickAddTokenKind | null }[] {
  const segments: { text: string; kind: QuickAddTokenKind | null }[] = [];
  let cursor = 0;
  for (const t of tokens) {
    if (t.start > cursor) segments.push({ text: text.slice(cursor, t.start), kind: null });
    segments.push({ text: text.slice(t.start, t.end), kind: t.kind });
    cursor = t.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: null });
  return segments;
}
