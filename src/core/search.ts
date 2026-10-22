/**
 * The /search URL contract: one canonical way to turn query-string params into
 * filters and back. Pure, so the server page, the client filter bar and tests
 * all agree on it. Invalid or unknown values are dropped (treated as omitted),
 * never thrown: a hand-edited URL shows a broader search, not an error page.
 */

export const SEARCH_TEXT_MAX = 200;
/** Rows shown per search; one more is fetched to know whether there were more. */
export const SEARCH_LIMIT = 200;

export type SearchStatus = "open" | "done" | "skipped" | "all";
export type SearchDue = "overdue" | "has" | "none";

export type SearchQuery = {
  /** Trimmed, whitespace collapsed, at most SEARCH_TEXT_MAX characters; "" = no text filter. */
  q: string;
  /** A project uuid (lowercase), "inbox" for tasks without a project, or null for all. */
  project: string | null;
  /** 1–4 (4 = no priority), or null for any. */
  priority: 1 | 2 | 3 | 4 | null;
  status: SearchStatus;
  /** "overdue": open with a deadline before the user's today. */
  due: SearchDue | null;
  /** true: open and waiting on an open blocker (as core/graph blockedSet); false: everything else. */
  blocked: boolean | null;
  /** true: has an estimate; false: has none. */
  estimate: boolean | null;
};

export const DEFAULT_SEARCH_QUERY: SearchQuery = {
  q: "",
  project: null,
  priority: null,
  status: "open",
  due: null,
  blocked: null,
  estimate: null,
};

/** Next's `searchParams` shape: a repeated key arrives as an array. */
export type SearchParamsInput = Record<string, string | string[] | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly SearchStatus[] = ["open", "done", "skipped", "all"];
const DUES: readonly SearchDue[] = ["overdue", "has", "none"];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Trims, turns control characters (Postgres rejects NUL in text) and runs of
 * whitespace into single spaces, and cuts to SEARCH_TEXT_MAX code points.
 */
export function normalizeSearchText(raw: string): string {
  const collapsed = raw.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  const chars = Array.from(collapsed);
  return chars.length <= SEARCH_TEXT_MAX ? collapsed : chars.slice(0, SEARCH_TEXT_MAX).join("").trimEnd();
}

function flag(value: string | undefined): boolean | null {
  return value === "1" ? true : value === "0" ? false : null;
}

export function parseSearchQuery(params: SearchParamsInput): SearchQuery {
  const project = first(params.project);
  const priority = first(params.priority);
  const status = first(params.status);
  const due = first(params.due);
  return {
    q: normalizeSearchText(first(params.q) ?? ""),
    project: project === "inbox" ? "inbox" : project && UUID_RE.test(project) ? project.toLowerCase() : null,
    priority: priority === "1" || priority === "2" || priority === "3" || priority === "4" ? (Number(priority) as 1 | 2 | 3 | 4) : null,
    status: STATUSES.find((s) => s === status) ?? "open",
    due: DUES.find((d) => d === due) ?? null,
    blocked: flag(first(params.blocked)),
    estimate: flag(first(params.estimate)),
  };
}

/** Canonical params: fixed key order, defaults left out. parseSearchQuery reads them back unchanged. */
export function searchQueryToParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  const q = normalizeSearchText(query.q);
  if (q !== "") params.set("q", q);
  if (query.project !== null) params.set("project", query.project);
  if (query.priority !== null) params.set("priority", String(query.priority));
  if (query.status !== "open") params.set("status", query.status);
  if (query.due !== null) params.set("due", query.due);
  if (query.blocked !== null) params.set("blocked", query.blocked ? "1" : "0");
  if (query.estimate !== null) params.set("estimate", query.estimate ? "1" : "0");
  return params;
}

/** "/search" or "/search?…" for `query`. */
export function searchHref(query: SearchQuery): string {
  const params = searchQueryToParams(query).toString();
  return params === "" ? "/search" : `/search?${params}`;
}

/** True if any filter (text included) differs from the defaults. */
export function hasActiveFilters(query: SearchQuery): boolean {
  return searchQueryToParams(query).toString() !== "";
}

/**
 * Escapes LIKE/ILIKE wildcards so user text matches literally: `\` -> `\\`,
 * `%` -> `\%`, `_` -> `\_` (backslash is Postgres's default LIKE escape).
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------------------
// The "/" shortcut

export type ShortcutKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
};

/** What the shortcut needs to know about the focused element (event.target). */
export type ShortcutTarget = {
  /** Upper-case tag name, as the DOM reports it. */
  tagName: string;
  /** `type` attribute for inputs. */
  type?: string;
  isContentEditable?: boolean;
  /** Inside an open <dialog> or an element with role="dialog"/aria-modal. */
  inDialog?: boolean;
};

// Inputs that take no typed text; "/" pressed on them can't be meant as input.
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/**
 * Whether a keydown should jump to search: a bare "/" (Shift is allowed, since
 * some layouts need it to type "/"), not while composing, and not while the
 * user is typing into a field or working in a dialog.
 */
export function shouldFocusSearch(event: ShortcutKeyEvent, target: ShortcutTarget | null): boolean {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.defaultPrevented || event.isComposing) return false;
  if (!target) return true;
  if (target.isContentEditable || target.inDialog) return false;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return false;
  if (target.tagName === "INPUT") return NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
  return true;
}
