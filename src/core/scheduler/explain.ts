/**
 * Plain-language reasons for the Plan My Day panel (spec §4.5).
 * Pure: turns the scheduler's reason codes into short labels.
 */

import type { Reason, SizeReason } from "./types";

/**
 * One or two short labels for why a task was picked, most important first
 * (by points, then score-table order), e.g. ["Overdue by 2 days", "Priority 1"].
 * Never empty: when no rule applies with points (e.g. only RECURRING or
 * ASSUMED_ESTIMATE, or no reasons at all) it still returns at least one label
 * ("Recurring", "Fits your time", …).
 */
export function explainReasons(reasons: ReadonlyArray<Reason>, max = 2): string[] {
  void reasons;
  void max;
  throw new Error("TODO(worker A): explainReasons");
}

/**
 * Why a task was left out for size, e.g. "Needs 3h, more than your 2h" (TOO_LARGE)
 * or "Needs 45m; 20m left" (NO_ROOM_LEFT).
 */
export function explainSize(size: SizeReason): string {
  void size;
  throw new Error("TODO(worker A): explainSize");
}
