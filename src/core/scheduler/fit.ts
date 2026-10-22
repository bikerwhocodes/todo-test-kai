/**
 * Scheduler step 2 (spec §4.4): fill the user's available time greedily from
 * the ranking, and say why anything important was left out.
 * Pure: everything comes in through `input`.
 */

import type { TaskId } from "../graph";
import { rankCandidates } from "./candidates";
import type {
  DidntFit,
  Draft,
  RankedCandidate,
  SchedulerTask,
  SizeReason,
  Suggestion,
  SuggestPlanInput,
} from "./types";
import { FALLBACK_DEFAULT_ESTIMATE_MIN, FIT_RULES, FITS_REMAINING_POINTS } from "./weights";

/** Overdue (not stale) or due today. Shown under "didn't fit" whatever its rank. */
function isUrgent(c: RankedCandidate): boolean {
  return c.reasons.some((r) => r.code === "OVERDUE" || r.code === "DUE_TODAY");
}

/**
 * Builds today's draft plan: `suggestions` that fit in the time left after
 * the existing plan, `didntFit` for oversized urgent or top-ranked tasks, and
 * `nothingFits` hints when no candidate fits at all.
 *
 * Walks the ranking once, best first. A task is picked when its effective
 * estimate (`estimateMin ?? defaultEstimateMin`) fits in the minutes left, so
 * the suggestions never exceed what is available. When a pick comes after a
 * higher-ranked task was skipped for size, it gets a FITS_REMAINING reason
 * ("Fits your remaining N min").
 *
 * Existing plan: tasks in `inPlanIds` are never suggested again. Their
 * effective estimates are subtracted from `availableMin`; done tasks don't
 * count. Pass every planned task in `tasks`: an id that isn't there is
 * counted at the default estimate, so the plan errs on the side of not
 * overfilling.
 *
 * Same input, same output. O(T log T + E).
 *
 * @throws RangeError for an invalid `availableMin`, `today` or default estimate.
 */
export function suggestPlan(input: SuggestPlanInput): Draft {
  const { availableMin } = input;
  if (!Number.isFinite(availableMin) || availableMin < 0) {
    throw new RangeError(`Invalid availableMin: ${availableMin}`);
  }
  const { ranked, excluded } = rankCandidates(input);
  const defaultEstimateMin = input.defaultEstimateMin ?? FALLBACK_DEFAULT_ESTIMATE_MIN;

  // Existing plan minutes.
  const byId = new Map<TaskId, SchedulerTask>();
  for (const t of input.tasks) byId.set(t.id, t);
  let existingMin = 0;
  let existingCount = 0;
  let assumedCount = 0;
  for (const id of new Set(input.inPlanIds ?? [])) {
    const t = byId.get(id);
    if (t && t.status !== "open") continue;
    const own = t?.estimateMin ?? 0;
    if (own > 0) {
      existingMin += own;
    } else {
      existingMin += defaultEstimateMin;
      assumedCount++;
    }
    existingCount++;
  }

  const capacity = Math.max(0, availableMin - existingMin);
  let remaining = capacity;
  let skippedForSize = false;
  const suggestions: Suggestion[] = [];
  const didntFit: DidntFit[] = [];

  ranked.forEach((c, i) => {
    const rank = i + 1;
    if (c.estimateMin <= remaining) {
      const reasons = skippedForSize
        ? [...c.reasons, { code: "FITS_REMAINING" as const, remainingMin: remaining, points: FITS_REMAINING_POINTS }]
        : c.reasons;
      suggestions.push({ ...c, reasons, rank });
      remaining -= c.estimateMin;
      return;
    }
    skippedForSize = true;
    if (rank <= FIT_RULES.didntFitTopRanks || isUrgent(c)) {
      didntFit.push({ ...c, rank, size: sizeReason(c, capacity, remaining) });
    }
  });

  let nothingFits: Draft["nothingFits"] = null;
  if (suggestions.length === 0 && ranked.length > 0) {
    const shortest = ranked
      .map((c, i) => ({ c, rank: i + 1 }))
      .sort((a, b) => a.c.estimateMin - b.c.estimateMin || a.rank - b.rank)
      .slice(0, FIT_RULES.nothingFitsHints)
      .map(({ c, rank }) => ({ ...c, rank, size: sizeReason(c, capacity, remaining) }));
    nothingFits = { shortest };
  }

  let suggestedMin = 0;
  for (const s of suggestions) {
    suggestedMin += s.estimateMin;
    if (s.reasons.some((r) => r.code === "ASSUMED_ESTIMATE")) assumedCount++;
  }
  const plannedMin = existingMin + suggestedMin;

  return {
    suggestions,
    didntFit,
    nothingFits,
    totals: {
      availableMin,
      existingMin,
      existingCount,
      suggestedMin,
      suggestedCount: suggestions.length,
      plannedMin,
      remainingMin: Math.max(0, availableMin - plannedMin),
      overMin: Math.max(0, existingMin - availableMin),
      assumedCount,
    },
    excluded,
  };
}

function sizeReason(c: RankedCandidate, capacity: number, remaining: number): SizeReason {
  return c.estimateMin > capacity
    ? { code: "TOO_LARGE", needMin: c.estimateMin, availableMin: capacity }
    : { code: "NO_ROOM_LEFT", needMin: c.estimateMin, remainingMin: remaining };
}
