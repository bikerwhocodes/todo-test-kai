// The Plan My Day panel's state and display rules. Pure: no React, no I/O, so the
// panel's behaviour is unit-tested here and the components only wire it up.

import { formatEstimate } from "@/core/format";
import { ESTIMATE_MAX_MIN, TITLE_MAX } from "@/lib/limits";

/** A task already in today's plan, as the Today page passes it to the panel. */
export type SavedPlanItem = { taskId: string; title: string; estimateMin: number | null; done: boolean };

/** One of the user's open tasks, for the "Add a task" search (mirrors PlanSearchOption). */
export type PlanOption = { id: string; title: string; estimateMin: number | null; projectId: string | null };

/**
 * A row of the review list.
 * - saved: already in today's plan (edits save at once).
 * - suggested: a scheduler pick in the draft.
 * - manual: added to the draft by the user (search, "Add anyway", "Split").
 */
export type RowKind = "saved" | "suggested" | "manual";

export type PlanRow = {
  taskId: string;
  title: string;
  /** The task's own estimate; null means the default is assumed. */
  estimateMin: number | null;
  /** Saved rows only: done tasks stay in the plan but don't count. */
  done: boolean;
  kind: RowKind;
  /** Suggestions: 1–2 plain-language reasons, never empty. */
  reasons: string[];
};

export type Segment = "saved" | "draft";

export type PanelState = { saved: PlanRow[]; draft: PlanRow[] };

/** Shown when the scheduler gives no label (it shouldn't): every suggestion has a reason. */
export const FALLBACK_REASON = "Fits your time";

export const PRESET_MINUTES = [60, 120, 240] as const;

export function isPreset(minutes: number): boolean {
  return (PRESET_MINUTES as readonly number[]).includes(minutes);
}

export const SEARCH_LIMIT = 8;

// --- Durations ---

const DURATION_RE = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/;

/**
 * Minutes in "90", "90m", "90 min", "1h", "1h 30m", "1h30m" or "1.5h"
 * (case-insensitive), or null when it isn't one of those. Fractional hours round
 * to the nearest minute. Doesn't check the range; see `readDuration`.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Number(text);
  const match = DURATION_RE.exec(text);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  return Math.round(hours * 60) + minutes;
}

export type DurationResult = { ok: true; minutes: number | null } | { ok: false; error: string };

/**
 * Parses and range-checks a typed duration: 1..1440 minutes. Empty is an error
 * unless `allowEmpty` (an estimate field, where empty clears the estimate).
 */
export function readDuration(input: string, { allowEmpty = false }: { allowEmpty?: boolean } = {}): DurationResult {
  if (input.trim() === "") return allowEmpty ? { ok: true, minutes: null } : { ok: false, error: "Enter a time" };
  const minutes = parseDuration(input);
  if (minutes === null) return { ok: false, error: "Try 90, 90m, 1h 30m or 1.5h" };
  if (minutes < 1) return { ok: false, error: "Enter at least 1 minute" };
  if (minutes > ESTIMATE_MAX_MIN) return { ok: false, error: "Enter at most 24h" };
  return { ok: true, minutes };
}

// --- Totals ---

export type Totals = { plannedMin: number; availableMin: number; overMin: number; remainingMin: number };

/**
 * Minutes of the open rows (done ones don't count), each at its estimate or the
 * default when it has none. Exactly filling the time is not over.
 */
export function planTotals(
  items: ReadonlyArray<Pick<PlanRow, "estimateMin" | "done">>,
  availableMin: number,
  defaultEstimateMin: number,
): Totals {
  let plannedMin = 0;
  for (const item of items) if (!item.done) plannedMin += effectiveEstimate(item.estimateMin, defaultEstimateMin);
  return {
    plannedMin,
    availableMin,
    overMin: Math.max(0, plannedMin - availableMin),
    remainingMin: Math.max(0, availableMin - plannedMin),
  };
}

export function effectiveEstimate(estimateMin: number | null, defaultEstimateMin: number): number {
  return estimateMin !== null && estimateMin > 0 ? estimateMin : defaultEstimateMin;
}

/** "1h 45m planned of 2h". */
export function formatPlannedOf(plannedMin: number, availableMin: number): string {
  return `${formatEstimate(plannedMin)} planned of ${formatEstimate(availableMin)}`;
}

/** "25 min over", always in minutes ("90 min over") so the number is easy to compare. */
export function formatOver(overMin: number): string {
  return `${overMin} min over`;
}

/** "Nothing fits in 30m. Your shortest tasks need 45m, 1h." */
export function formatNothingFits(availableMin: number, shortestMin: ReadonlyArray<number>): string {
  const head = `Nothing fits in ${formatEstimate(availableMin)}.`;
  if (shortestMin.length === 0) return head;
  const shown = shortestMin.slice(0, 3).map(formatEstimate).join(", ");
  const more = shortestMin.length > 3 ? "…" : ".";
  return `${head} Your shortest ${shortestMin.length === 1 ? "task needs" : "tasks need"} ${shown}${more}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Why there is nothing to plan, from the draft's exclusions and blocked list,
 * e.g. ["3 tasks are blocked", "1 task was set aside for today"].
 */
export function nothingToPlanReasons(
  excluded: ReadonlyArray<{ reason: string }>,
  blockedCount: number,
): string[] {
  const count = (reason: string) => excluded.filter((e) => e.reason === reason).length;
  const blocked = Math.max(blockedCount, count("blocked"));
  const dismissed = count("dismissed");
  const future = count("future_occurrence");
  const out: string[] = [];
  if (blocked > 0) out.push(`${plural(blocked, "task is", "tasks are")} blocked`);
  if (dismissed > 0) out.push(`${plural(dismissed, "task was", "tasks were")} set aside for today`);
  if (future > 0) out.push(`${plural(future, "repeating task isn't", "repeating tasks aren't")} due yet`);
  if (out.length === 0) out.push("You have no open tasks");
  return out;
}

// --- Lists ---

/**
 * `list` with the item at `index` moved by `delta` places, or `list` itself when
 * that would go past either end (so callers can tell nothing moved).
 */
export function moveItem<T>(list: ReadonlyArray<T>, index: number, delta: number): T[] {
  return moveTo(list, index, index + delta);
}

/** `list` with the item at `from` now at `to`; `list` itself when either is out of range or they match. */
export function moveTo<T>(list: ReadonlyArray<T>, from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list as T[];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Where a dragged row at `from` lands when dropped before the row at `before` (`length` = after the last). */
export function dropIndex(from: number, before: number): number {
  return before > from ? before - 1 : before;
}

/** "Moved Write report to position 2 of 5". */
export function moveAnnouncement(title: string, index: number, length: number): string {
  return `Moved ${title} to position ${index + 1} of ${length}`;
}

/**
 * Up to `limit` options whose title contains `query` (case-insensitive), in
 * their given order, leaving out `excludeIds`. An empty query matches nothing.
 */
export function filterSearch<T extends { id: string; title: string }>(
  options: ReadonlyArray<T>,
  query: string,
  excludeIds: Iterable<string>,
  limit = SEARCH_LIMIT,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  const excluded = new Set(excludeIds);
  const out: T[] = [];
  for (const o of options) {
    if (out.length >= limit) break;
    if (!excluded.has(o.id) && o.title.toLocaleLowerCase().includes(needle)) out.push(o);
  }
  return out;
}

/** Ids in either segment, so search and "Add anyway" don't offer them again. */
export function rowIds(state: PanelState): Set<string> {
  return new Set([...state.saved, ...state.draft].map((r) => r.taskId));
}

/** 1–2 reason chips; never empty. */
export function reasonChips(labels: ReadonlyArray<string>): string[] {
  const chips = labels.filter((l) => l.trim() !== "").slice(0, 2);
  return chips.length > 0 ? chips : [FALLBACK_REASON];
}

/** "<title> (part 1)", shortening the title so the result stays a valid title. */
export function splitTitle(title: string): string {
  const suffix = " (part 1)";
  const room = TITLE_MAX - suffix.length;
  const base = title.length > room ? `${title.slice(0, room - 1).trimEnd()}…` : title;
  return `${base}${suffix}`;
}

/** The first part's default size: the time left, else 30 min. */
export function defaultSplitMin(remainingMin: number): number {
  return remainingMin > 0 ? Math.min(remainingMin, ESTIMATE_MAX_MIN) : 30;
}

/** What "Add N to plan" sends: the draft in order, which of it was added by hand, and the time. */
export function acceptPayload(
  draft: ReadonlyArray<PlanRow>,
  availableMin: number,
): { taskIds: string[]; availableMin: number; manualTaskIds: string[] } {
  return {
    taskIds: draft.map((r) => r.taskId),
    availableMin,
    manualTaskIds: draft.filter((r) => r.kind === "manual").map((r) => r.taskId),
  };
}

export function acceptLabel(draftCount: number): string {
  return draftCount === 0 ? "Done" : `Add ${draftCount} to plan`;
}

// --- Rows ---

export function savedRows(items: ReadonlyArray<SavedPlanItem>): PlanRow[] {
  return items.map((i) => ({ ...i, kind: "saved" as const, reasons: [] }));
}

export function manualRow(task: { id: string; title: string; estimateMin: number | null }): PlanRow {
  return { taskId: task.id, title: task.title, estimateMin: task.estimateMin, done: false, kind: "manual", reasons: [] };
}

export function suggestionRow(s: { id: string; title: string; estimateMin: number | null; reasons: string[] }): PlanRow {
  return {
    taskId: s.id,
    title: s.title,
    estimateMin: s.estimateMin,
    done: false,
    kind: "suggested",
    reasons: reasonChips(s.reasons),
  };
}

// --- Reducer ---

export type PanelAction =
  /** New suggestions replace the old ones; rows added by hand stay, after them. */
  | { type: "setDraft"; suggestions: PlanRow[] }
  | { type: "reset"; saved: PlanRow[] }
  | { type: "remove"; taskId: string }
  /** Puts a removed row back where it was (an optimistic removal failed). */
  | { type: "restore"; segment: Segment; index: number; row: PlanRow }
  | { type: "move"; segment: Segment; index: number; delta: number }
  | { type: "moveTo"; segment: Segment; from: number; to: number }
  /** Replaces a segment's order wholesale (a saved reorder failed and is undone). */
  | { type: "setOrder"; segment: Segment; rows: PlanRow[] }
  | { type: "addManual"; row: PlanRow }
  | { type: "setEstimate"; taskId: string; estimateMin: number | null };

export function initialPanelState(saved: ReadonlyArray<SavedPlanItem>): PanelState {
  return { saved: savedRows(saved), draft: [] };
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "reset":
      return { saved: action.saved, draft: [] };
    case "setDraft": {
      const saved = new Set(state.saved.map((r) => r.taskId));
      const manual = state.draft.filter((r) => r.kind === "manual");
      const manualIds = new Set(manual.map((r) => r.taskId));
      const suggestions = action.suggestions.filter((r) => !saved.has(r.taskId) && !manualIds.has(r.taskId));
      return { ...state, draft: [...suggestions, ...manual] };
    }
    case "remove":
      return {
        saved: state.saved.filter((r) => r.taskId !== action.taskId),
        draft: state.draft.filter((r) => r.taskId !== action.taskId),
      };
    case "restore": {
      if (rowIds(state).has(action.row.taskId)) return state;
      const list = [...state[action.segment]];
      list.splice(Math.max(0, Math.min(action.index, list.length)), 0, action.row);
      return { ...state, [action.segment]: list };
    }
    case "move": {
      const list = moveItem(state[action.segment], action.index, action.delta);
      return list === state[action.segment] ? state : { ...state, [action.segment]: list };
    }
    case "moveTo": {
      const list = moveTo(state[action.segment], action.from, action.to);
      return list === state[action.segment] ? state : { ...state, [action.segment]: list };
    }
    case "setOrder":
      return { ...state, [action.segment]: action.rows };
    case "addManual":
      if (rowIds(state).has(action.row.taskId)) return state;
      return { ...state, draft: [...state.draft, { ...action.row, kind: "manual", reasons: [] }] };
    case "setEstimate": {
      const patch = (rows: PlanRow[]) =>
        rows.map((r) => (r.taskId === action.taskId ? { ...r, estimateMin: action.estimateMin } : r));
      return { saved: patch(state.saved), draft: patch(state.draft) };
    }
  }
}

/** The segment and index of a row, or null. */
export function findRow(state: PanelState, taskId: string): { segment: Segment; index: number; row: PlanRow } | null {
  for (const segment of ["saved", "draft"] as const) {
    const index = state[segment].findIndex((r) => r.taskId === taskId);
    if (index >= 0) return { segment, index, row: state[segment][index]! };
  }
  return null;
}
