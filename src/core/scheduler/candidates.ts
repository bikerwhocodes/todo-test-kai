/**
 * Scheduler step 1 (spec §4.2–4.3): pick the candidates for today's plan,
 * score them with the table in `weights.ts`, and rank them deterministically.
 * Pure: `today` is injected and nothing reads the clock.
 */

import { assertIsoDate, compareIsoDate, diffDays, type IsoDate } from "../dates";
import { blockedSet, type TaskId } from "../graph";
import type {
  CandidateInput,
  CandidateResult,
  ExclusionReason,
  RankedCandidate,
  Reason,
  SchedulerTask,
} from "./types";
import {
  ASSUMED_ESTIMATE_POINTS,
  CARRIED_OVER_POINTS,
  DEADLINE_WEIGHTS as D,
  FALLBACK_DEFAULT_ESTIMATE_MIN,
  PRIORITY_WEIGHTS,
  RECURRING_POINTS,
  UNBLOCKS_WEIGHTS,
} from "./weights";

export interface ScoreContext {
  readonly today: IsoDate;
  /** Number of open tasks that this task directly blocks. */
  readonly unblocksCount: number;
  readonly carriedOver: boolean;
  readonly defaultEstimateMin: number;
}

/** The deadline-row reason for a due date, or null when none applies. */
function deadlineReason(dueDate: IsoDate, today: IsoDate): Reason | null {
  const days = diffDays(today, dueDate);
  if (days < 0) {
    const late = -days;
    if (late > D.staleAfterDays) return { code: "STALE_OVERDUE", days: late, points: D.staleOverdue };
    const points = Math.min(D.overdueBase + D.overduePerDay * (late - 1), D.overdueMax);
    return { code: "OVERDUE", days: late, points };
  }
  if (days === 0) return { code: "DUE_TODAY", points: D.dueToday };
  if (days === 1) return { code: "DUE_TOMORROW", points: D.dueTomorrow };
  if (days <= D.dueInMaxDays) {
    return { code: "DUE_IN", days, points: D.dueInBase - D.dueInPerDay * (days - 2) };
  }
  return null;
}

/**
 * Scores one task against the §4.3 table. Returns the total, the reasons in
 * table order, and the estimate the fit step should use.
 */
export function scoreTask(
  task: SchedulerTask,
  ctx: ScoreContext,
): Pick<RankedCandidate, "score" | "reasons" | "estimateMin" | "dueDate"> {
  const reasons: Reason[] = [];
  const dueDate = task.deadline ?? task.occurrenceDate;

  if (dueDate !== null) {
    const r = deadlineReason(dueDate, ctx.today);
    if (r) reasons.push(r);
  }
  const priorityPoints = PRIORITY_WEIGHTS[task.priority];
  if (priorityPoints > 0) {
    reasons.push({ code: "PRIORITY", priority: task.priority, points: priorityPoints });
  }
  if (ctx.unblocksCount > 0) {
    const points = Math.min(UNBLOCKS_WEIGHTS.perTask * ctx.unblocksCount, UNBLOCKS_WEIGHTS.max);
    reasons.push({ code: "UNBLOCKS", count: ctx.unblocksCount, points });
  }
  if (ctx.carriedOver) reasons.push({ code: "CARRIED_OVER", points: CARRIED_OVER_POINTS });
  if (task.seriesId !== null) reasons.push({ code: "RECURRING", points: RECURRING_POINTS });

  let estimateMin = task.estimateMin ?? 0;
  if (!(estimateMin > 0)) {
    estimateMin = ctx.defaultEstimateMin;
    reasons.push({ code: "ASSUMED_ESTIMATE", minutes: estimateMin, points: ASSUMED_ESTIMATE_POINTS });
  }

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return { score, reasons, estimateMin, dueDate };
}

/**
 * Ranking order: higher score first, then the tie-break chain
 * earlier due date (none last) > higher priority > shorter estimate >
 * earlier createdAt > smaller id (code-unit order, locale-independent).
 */
export function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return compareIsoDate(a.dueDate, b.dueDate);
  }
  if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;
  if (a.estimateMin !== b.estimateMin) return a.estimateMin - b.estimateMin;
  const ta = a.task.createdAt.getTime();
  const tb = b.task.createdAt.getTime();
  if (ta !== tb) return ta - tb;
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
}

/**
 * Filters the user's tasks down to today's candidates and ranks them.
 *
 * Excluded, first matching reason wins: not open (done/skipped), already in
 * today's plan, dismissed today, a recurring occurrence dated after today,
 * blocked by an open task. Blocked tasks are never ranked.
 *
 * Same input, same output: ordering never depends on input order.
 * O(T log T + E).
 *
 * @throws RangeError for an invalid `today`, due date or default estimate.
 */
export function rankCandidates(input: CandidateInput): CandidateResult {
  const { today, tasks, edges } = input;
  assertIsoDate(today, "today");
  const defaultEstimateMin = input.defaultEstimateMin ?? FALLBACK_DEFAULT_ESTIMATE_MIN;
  if (!Number.isFinite(defaultEstimateMin) || defaultEstimateMin <= 0) {
    throw new RangeError(`Invalid defaultEstimateMin: ${defaultEstimateMin}`);
  }

  const inPlan = new Set(input.inPlanIds ?? []);
  const dismissed = new Set(input.dismissedIds ?? []);
  const carriedOver = new Set(input.carriedOverIds ?? []);
  const blocked = blockedSet(
    tasks.map((t) => ({ id: t.id, open: t.status === "open" })),
    edges,
  );

  const openIds = new Set<TaskId>();
  for (const t of tasks) if (t.status === "open") openIds.add(t.id);
  // Count distinct open dependents per blocker (duplicate edges count once).
  const dependents = new Map<TaskId, Set<TaskId>>();
  for (const e of edges) {
    if (!openIds.has(e.taskId)) continue;
    let s = dependents.get(e.blockedById);
    if (!s) dependents.set(e.blockedById, (s = new Set()));
    s.add(e.taskId);
  }

  const ranked: RankedCandidate[] = [];
  const excluded: { id: TaskId; reason: ExclusionReason }[] = [];
  for (const task of tasks) {
    const reason = exclusionReason(task, today, inPlan, dismissed, blocked);
    if (reason) {
      excluded.push({ id: task.id, reason });
      continue;
    }
    ranked.push({
      task,
      ...scoreTask(task, {
        today,
        unblocksCount: dependents.get(task.id)?.size ?? 0,
        carriedOver: carriedOver.has(task.id),
        defaultEstimateMin,
      }),
    });
  }
  ranked.sort(compareCandidates);
  return { ranked, excluded };
}

function exclusionReason(
  task: SchedulerTask,
  today: IsoDate,
  inPlan: ReadonlySet<TaskId>,
  dismissed: ReadonlySet<TaskId>,
  blocked: ReadonlySet<TaskId>,
): ExclusionReason | null {
  if (task.status !== "open") return "done";
  if (inPlan.has(task.id)) return "in_plan";
  if (dismissed.has(task.id)) return "dismissed";
  if (task.occurrenceDate !== null && compareIsoDate(task.occurrenceDate, today) > 0) {
    return "future_occurrence";
  }
  if (blocked.has(task.id)) return "blocked";
  return null;
}
