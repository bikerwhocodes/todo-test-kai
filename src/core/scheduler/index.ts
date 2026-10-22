/**
 * core/scheduler — explainable "Plan My Day" ranking (spec §4, plan §M4a).
 * Pure: no I/O, no clock. Weights live in `weights.ts`.
 */

export { compareCandidates, rankCandidates, scoreTask, type ScoreContext } from "./candidates";
export type {
  CandidateInput,
  CandidateResult,
  ExclusionReason,
  Priority,
  RankedCandidate,
  Reason,
  ReasonCode,
  SchedulerTask,
  TaskStatus,
} from "./types";
export * from "./weights";
