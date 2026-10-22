/**
 * Plain-language reasons for the Plan My Day panel (spec §4.5).
 * Pure: turns the scheduler's reason codes into short labels.
 */

import { formatEstimate } from "../format";
import type { Reason, ReasonCode, SizeReason } from "./types";

/** Score-table order (see weights.ts); breaks ties between equal points. */
const TABLE_ORDER: Readonly<Record<ReasonCode, number>> = {
  OVERDUE: 0,
  STALE_OVERDUE: 1,
  DUE_TODAY: 2,
  DUE_TOMORROW: 3,
  DUE_IN: 4,
  PRIORITY: 5,
  UNBLOCKS: 6,
  CARRIED_OVER: 7,
  RECURRING: 8,
  ASSUMED_ESTIMATE: 9,
  FITS_REMAINING: 10,
};

/** Shown when there is no reason at all, so a pick is never unexplained. */
const FALLBACK_LABEL = "Fits your time";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The label for one reason, e.g. "Overdue by 2 days". */
function label(r: Reason): string {
  switch (r.code) {
    case "OVERDUE":
      return `Overdue by ${plural(r.days, "day", "days")}`;
    case "STALE_OVERDUE":
      return `Overdue ${plural(r.days, "day", "days")}`;
    case "DUE_TODAY":
      return "Due today";
    case "DUE_TOMORROW":
      return "Due tomorrow";
    case "DUE_IN":
      return `Due in ${plural(r.days, "day", "days")}`;
    case "PRIORITY":
      return `Priority ${r.priority}`;
    case "UNBLOCKS":
      return `Unblocks ${plural(r.count, "task", "tasks")}`;
    case "CARRIED_OVER":
      return "From yesterday";
    case "RECURRING":
      return "Recurring";
    case "ASSUMED_ESTIMATE":
      return `No estimate: assuming ${formatEstimate(r.minutes)}`;
    case "FITS_REMAINING":
      return `Fits your remaining ${formatEstimate(r.remainingMin)}`;
  }
}

/**
 * One or two short labels for why a task was picked, most important first
 * (by points, then score-table order), e.g. ["Overdue by 2 days", "Priority 1"].
 * Never empty: when no rule applies with points (e.g. only RECURRING or
 * ASSUMED_ESTIMATE, or no reasons at all) it still returns at least one label
 * ("Recurring", "Fits your time", …).
 *
 * Zero-point reasons only fill the slots the point reasons leave free. A `max`
 * below 1 counts as 1.
 */
export function explainReasons(reasons: ReadonlyArray<Reason>, max = 2): string[] {
  const limit = Math.max(1, Math.floor(max));
  const byTable = (a: Reason, b: Reason) => TABLE_ORDER[a.code] - TABLE_ORDER[b.code];
  const scored = reasons.filter((r) => r.points > 0).sort((a, b) => b.points - a.points || byTable(a, b));
  const free = reasons.filter((r) => !(r.points > 0)).sort(byTable);
  const labels = [...scored, ...free].slice(0, limit).map(label);
  return labels.length > 0 ? labels : [FALLBACK_LABEL];
}

/**
 * Why a task was left out for size, e.g. "Needs 3h, more than your 2h" (TOO_LARGE)
 * or "Needs 45m; 20m left" (NO_ROOM_LEFT).
 */
export function explainSize(size: SizeReason): string {
  const need = formatEstimate(size.needMin);
  return size.code === "TOO_LARGE"
    ? `Needs ${need}, more than your ${formatEstimate(size.availableMin)}`
    : `Needs ${need}; ${formatEstimate(size.remainingMin)} left`;
}
