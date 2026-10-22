import type { IsoDate } from "../dates";
import type { DependencyEdge, TaskId } from "../graph";

export type Priority = 1 | 2 | 3 | 4;
export type TaskStatus = "open" | "done" | "skipped";

/** The task fields the scheduler reads. Mirrors the `tasks` row. */
export interface SchedulerTask {
  readonly id: TaskId;
  readonly status: TaskStatus;
  /** 1 is the highest; 4 means "no priority". */
  readonly priority: Priority;
  readonly deadline: IsoDate | null;
  /** Minutes; null when the user gave no estimate. */
  readonly estimateMin: number | null;
  readonly createdAt: Date;
  /** Set for occurrences of a recurring series. */
  readonly seriesId: string | null;
  readonly occurrenceDate: IsoDate | null;
}

export interface CandidateInput {
  /** The user's local date, from `localToday(tz, now)`. */
  readonly today: IsoDate;
  /**
   * The user's tasks. Include every open task that blocks another one, or the
   * blocked task will look unblocked (missing blockers count as done).
   */
  readonly tasks: ReadonlyArray<SchedulerTask>;
  readonly edges: ReadonlyArray<DependencyEdge>;
  /** Tasks already in today's plan. */
  readonly inPlanIds?: ReadonlyArray<TaskId>;
  /** Suggestions the user dismissed today. */
  readonly dismissedIds?: ReadonlyArray<TaskId>;
  /** Tasks that were in yesterday's plan and not finished. */
  readonly carriedOverIds?: ReadonlyArray<TaskId>;
  /** The user's default estimate in minutes, used when a task has none. Default 30. */
  readonly defaultEstimateMin?: number;
}

/** Why a task is in the ranking. `points` is what the rule added to the score. */
export type Reason =
  | { readonly code: "OVERDUE"; readonly days: number; readonly points: number }
  | { readonly code: "STALE_OVERDUE"; readonly days: number; readonly points: number }
  | { readonly code: "DUE_TODAY"; readonly points: number }
  | { readonly code: "DUE_TOMORROW"; readonly points: number }
  | { readonly code: "DUE_IN"; readonly days: number; readonly points: number }
  | { readonly code: "PRIORITY"; readonly priority: Priority; readonly points: number }
  | { readonly code: "UNBLOCKS"; readonly count: number; readonly points: number }
  | { readonly code: "CARRIED_OVER"; readonly points: number }
  | { readonly code: "RECURRING"; readonly points: number }
  | { readonly code: "ASSUMED_ESTIMATE"; readonly minutes: number; readonly points: number }
  /** Added by the greedy fit step, not by scoring. */
  | { readonly code: "FITS_REMAINING"; readonly remainingMin: number; readonly points: number };

export type ReasonCode = Reason["code"];

export type ExclusionReason = "done" | "in_plan" | "dismissed" | "future_occurrence" | "blocked";

export interface RankedCandidate {
  readonly task: SchedulerTask;
  readonly score: number;
  /** The task's estimate, or the default when it has none. */
  readonly estimateMin: number;
  /** The date the deadline rules used: `deadline`, else `occurrenceDate`. */
  readonly dueDate: IsoDate | null;
  /** In score-table order. */
  readonly reasons: ReadonlyArray<Reason>;
}

export interface SuggestPlanInput extends CandidateInput {
  /** Minutes the user has today, as entered in Plan My Day. Must be finite and >= 0. */
  readonly availableMin: number;
}

/** A pick for today's plan. `reasons` may end with FITS_REMAINING. */
export interface Suggestion extends RankedCandidate {
  /** 1-based position in the full ranking. */
  readonly rank: number;
}

/**
 * Why a candidate was left out for its size.
 * - TOO_LARGE: needs more than all of the time available after the existing plan ("split it").
 * - NO_ROOM_LEFT: would fit on its own, but higher-ranked picks used the time first.
 */
export type SizeReason =
  | { readonly code: "TOO_LARGE"; readonly needMin: number; readonly availableMin: number }
  | { readonly code: "NO_ROOM_LEFT"; readonly needMin: number; readonly remainingMin: number };

export interface DidntFit extends RankedCandidate {
  readonly rank: number;
  readonly size: SizeReason;
}

export interface PlanTotals {
  /** As passed in. */
  readonly availableMin: number;
  /** Effective minutes of open tasks already in today's plan. */
  readonly existingMin: number;
  readonly existingCount: number;
  /** Effective minutes of the new suggestions. */
  readonly suggestedMin: number;
  readonly suggestedCount: number;
  /** existingMin + suggestedMin. Can exceed availableMin only when the existing plan already did. */
  readonly plannedMin: number;
  /** max(0, availableMin − plannedMin). */
  readonly remainingMin: number;
  /** Existing plan minutes beyond availableMin; 0 when within. */
  readonly overMin: number;
  /** Planned items (existing + suggested) that use the default estimate. */
  readonly assumedCount: number;
}

/** The result of `suggestPlan`. Nothing is saved; the user reviews and accepts it. */
export interface Draft {
  /** In rank order. Never includes tasks already in the plan. */
  readonly suggestions: ReadonlyArray<Suggestion>;
  /** Oversized urgent or top-ranked candidates, in rank order. */
  readonly didntFit: ReadonlyArray<DidntFit>;
  /**
   * Set when there are candidates but none fits: the shortest ones (shortest
   * first, then rank order) so the UI can say "Your shortest tasks need …".
   */
  readonly nothingFits: { readonly shortest: ReadonlyArray<DidntFit> } | null;
  readonly totals: PlanTotals;
  /** From the candidate filter, in input order. */
  readonly excluded: CandidateResult["excluded"];
}

export interface CandidateResult {
  /** Best first; see `compareCandidates`. */
  readonly ranked: ReadonlyArray<RankedCandidate>;
  /** In input order. */
  readonly excluded: ReadonlyArray<{ readonly id: TaskId; readonly reason: ExclusionReason }>;
}
