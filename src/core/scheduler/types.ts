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

export interface CandidateResult {
  /** Best first; see `compareCandidates`. */
  readonly ranked: ReadonlyArray<RankedCandidate>;
  /** In input order. */
  readonly excluded: ReadonlyArray<{ readonly id: TaskId; readonly reason: ExclusionReason }>;
}
