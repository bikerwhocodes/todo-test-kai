/**
 * core/scheduler — explainable "Plan My Day" ranking (spec §4, plan §M4a).
 * Pure: no I/O, no clock. Weights live in `weights.ts`.
 */

export { compareCandidates, rankCandidates, scoreTask, type ScoreContext } from "./candidates";
export { suggestPlan } from "./fit";
export type {
  CandidateInput,
  CandidateResult,
  DidntFit,
  Draft,
  ExclusionReason,
  PlanTotals,
  Priority,
  RankedCandidate,
  Reason,
  ReasonCode,
  SchedulerTask,
  SizeReason,
  Suggestion,
  SuggestPlanInput,
  TaskStatus,
} from "./types";
export * from "./weights";
