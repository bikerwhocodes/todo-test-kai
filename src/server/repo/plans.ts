import "server-only";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { assertIsoDate, type IsoDate } from "@/core/dates";
import {
  suggestPlan,
  type CandidateInput,
  type DidntFit,
  type Draft,
  type Priority,
  type SchedulerTask,
  type Suggestion,
} from "@/core/scheduler";
import { db } from "@/server/db";
import {
  dayPlans,
  planDismissals,
  planItems,
  taskDependencies,
  tasks,
  type DayPlan,
  type PlanItemSource,
  type Task,
  type TaskStatus,
} from "@/server/db/schema";
import { ConflictError, NotFoundError } from "./errors";
import { withSubtasksAndBlockers, type TaskWithSubtasks } from "./tasks";
import { getUserSettings } from "./user-settings";

// Plan My Day (spec §4). Every function takes userId first and scopes every query by
// it. `today` is the user's localToday (getUserToday), so plans and dismissals follow
// the user's calendar, not UTC.
//
// Only day_plans, plan_items and plan_dismissals are ever written here: planning
// never changes a task. Writes lock the tasks they name (KEY SHARE) and then the
// day's plan row, always in that order, so concurrent edits of one plan run one at a
// time and positions never interleave.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PlannedTask = {
  itemId: string;
  position: number;
  source: PlanItemSource;
  task: TaskWithSubtasks;
};

export type DayPlanView = {
  /** Null when there is no plan for the date or no time was entered. */
  availableMin: number | null;
  /** In plan order. Done tasks stay in the plan. */
  items: PlannedTask[];
};

/** A scheduler pick with what the Plan My Day panel shows for it. */
export type Titled<T> = T & { title: string; projectId: string | null };

/** `suggestPlan`'s draft, with titles. Nothing is saved until the user accepts it. */
export type PlanDraft = Omit<Draft, "suggestions" | "didntFit" | "nothingFits"> & {
  suggestions: Titled<Suggestion>[];
  didntFit: Titled<DidntFit>[];
  nothingFits: { shortest: Titled<DidntFit>[] } | null;
};

/** The user's plan for `date`, or an empty one if there is none. Read-only. */
export async function getPlan(userId: string, date: IsoDate): Promise<DayPlanView> {
  assertIsoDate(date, "date");
  const [plan] = await db
    .select({ id: dayPlans.id, availableMin: dayPlans.availableMin })
    .from(dayPlans)
    .where(and(eq(dayPlans.userId, userId), eq(dayPlans.planDate, date)));
  if (!plan) return { availableMin: null, items: [] };

  const rows = await db
    .select({ id: planItems.id, position: planItems.position, source: planItems.source, task: tasks })
    .from(planItems)
    .innerJoin(tasks, and(eq(tasks.userId, planItems.userId), eq(tasks.id, planItems.taskId)))
    .where(and(eq(planItems.userId, userId), eq(planItems.dayPlanId, plan.id)))
    .orderBy(asc(planItems.position), asc(planItems.createdAt), asc(planItems.id));
  const full = await withSubtasksAndBlockers(
    userId,
    rows.map((r) => r.task),
  );
  return {
    availableMin: plan.availableMin,
    items: rows.map((r, i) => ({ itemId: r.id, position: r.position, source: r.source, task: full[i]! })),
  };
}

/**
 * The scheduler input for the user's `today`: every open task (so every open
 * blocker is there), plus today's planned tasks whatever their status (so done
 * ones don't count against the time), the dependency edges, today's plan and
 * dismissals, and the open tasks of the latest earlier plan ("From yesterday").
 *
 * Read-only. getUserSettings creates a missing settings row, but every signed-up
 * user has one (the signup hook writes it), so in practice this never writes.
 */
export async function loadPlanInput(userId: string, today: IsoDate): Promise<CandidateInput> {
  return (await loadPlanData(userId, today)).input;
}

async function loadPlanData(userId: string, today: IsoDate): Promise<{ input: CandidateInput; rows: Map<string, Task> }> {
  assertIsoDate(today, "today");
  const [settings, open, planned, dismissed, edges, carriedOverIds] = await Promise.all([
    getUserSettings(userId),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.status, "open"))),
    db
      .select({ task: tasks })
      .from(planItems)
      .innerJoin(dayPlans, and(eq(dayPlans.userId, planItems.userId), eq(dayPlans.id, planItems.dayPlanId)))
      .innerJoin(tasks, and(eq(tasks.userId, planItems.userId), eq(tasks.id, planItems.taskId)))
      .where(and(eq(planItems.userId, userId), eq(dayPlans.planDate, today)))
      .orderBy(asc(planItems.position), asc(planItems.createdAt), asc(planItems.id)),
    db
      .select({ taskId: planDismissals.taskId })
      .from(planDismissals)
      .where(and(eq(planDismissals.userId, userId), eq(planDismissals.planDate, today))),
    db
      .select({ taskId: taskDependencies.taskId, blockedById: taskDependencies.blockedByTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.userId, userId)),
    carriedOver(userId, today),
  ]);

  const rows = new Map<string, Task>();
  for (const t of open) rows.set(t.id, t);
  for (const { task } of planned) rows.set(task.id, task);

  return {
    input: {
      today,
      tasks: [...rows.values()].map(toSchedulerTask),
      edges,
      inPlanIds: planned.map((p) => p.task.id),
      dismissedIds: dismissed.map((d) => d.taskId),
      carriedOverIds,
      defaultEstimateMin: settings.defaultEstimateMin,
    },
    rows,
  };
}

/** Open tasks of the user's latest plan before `today`, in that plan's order. */
async function carriedOver(userId: string, today: IsoDate): Promise<string[]> {
  const [previous] = await db
    .select({ id: dayPlans.id })
    .from(dayPlans)
    .where(and(eq(dayPlans.userId, userId), lt(dayPlans.planDate, today)))
    .orderBy(desc(dayPlans.planDate))
    .limit(1);
  if (!previous) return [];
  const rows = await db
    .select({ taskId: planItems.taskId })
    .from(planItems)
    .innerJoin(tasks, and(eq(tasks.userId, planItems.userId), eq(tasks.id, planItems.taskId)))
    .where(and(eq(planItems.userId, userId), eq(planItems.dayPlanId, previous.id), eq(tasks.status, "open")))
    .orderBy(asc(planItems.position), asc(planItems.createdAt), asc(planItems.id));
  return rows.map((r) => r.taskId);
}

function toSchedulerTask(t: Task): SchedulerTask {
  return {
    id: t.id,
    status: t.status,
    // Guaranteed 1..4 by tasks_priority_range.
    priority: t.priority as Priority,
    deadline: t.deadline,
    estimateMin: t.estimateMin,
    createdAt: t.createdAt,
    seriesId: t.seriesId,
    occurrenceDate: t.occurrenceDate,
  };
}

/** Today's draft plan for `availableMin` minutes (see core/scheduler suggestPlan). Saves nothing. */
export async function suggest(userId: string, today: IsoDate, availableMin: number): Promise<PlanDraft> {
  const { input, rows } = await loadPlanData(userId, today);
  const draft = suggestPlan({ ...input, availableMin });
  const titled = <T extends { task: SchedulerTask }>(c: T): Titled<T> => {
    const row = rows.get(c.task.id);
    return { ...c, title: row?.title ?? "", projectId: row?.projectId ?? null };
  };
  return {
    ...draft,
    suggestions: draft.suggestions.map(titled),
    didntFit: draft.didntFit.map(titled),
    nothingFits: draft.nothingFits ? { shortest: draft.nothingFits.shortest.map(titled) } : null,
    excluded: [...draft.excluded],
  };
}

/**
 * Appends the accepted suggestions to today's plan, in the given order, after any
 * items already there (whose order is kept). Tasks already in the plan and
 * repeated ids are skipped. Sets the plan's available time when given.
 * Creates the plan row on first use. Returns the ids that were added.
 *
 * Throws NotFoundError when any id isn't one of the user's tasks (another user's
 * task looks missing), and ConflictError, saving nothing, when a task to add isn't
 * open any more (e.g. it was completed in another tab after the suggestion).
 */
export async function acceptSuggestions(
  userId: string,
  today: IsoDate,
  { taskIds, availableMin }: { taskIds: string[]; availableMin?: number },
): Promise<string[]> {
  assertIsoDate(today, "today");
  const ids = [...new Set(taskIds)];
  return db.transaction(async (tx) => {
    const statuses = await lockOwnTasks(tx, userId, ids);
    const plan = await lockPlan(tx, userId, today);
    const existing = await itemsOf(tx, userId, plan.id);
    const inPlan = new Set(existing.map((i) => i.taskId));
    const added = ids.filter((id) => !inPlan.has(id));
    if (added.some((id) => statuses.get(id) !== "open")) {
      throw new ConflictError("Only open tasks can be added to the plan");
    }
    if (added.length > 0) {
      const next = nextPosition(existing);
      await tx.insert(planItems).values(
        added.map((taskId, i) => ({
          userId,
          dayPlanId: plan.id,
          taskId,
          position: next + i,
          source: "suggested" as const,
        })),
      );
    }
    if (availableMin !== undefined) {
      await tx
        .update(dayPlans)
        .set({ availableMin, updatedAt: new Date() })
        .where(and(eq(dayPlans.userId, userId), eq(dayPlans.id, plan.id)));
    }
    return added;
  });
}

/**
 * Adds a task to the end of today's plan by hand; a no-op if it is already there.
 * Also undoes a "Not today" dismissal of it. NotFoundError for a task that isn't
 * the user's; ConflictError for one that isn't open.
 */
export async function addPlanItem(userId: string, today: IsoDate, taskId: string): Promise<void> {
  assertIsoDate(today, "today");
  await db.transaction(async (tx) => {
    const statuses = await lockOwnTasks(tx, userId, [taskId]);
    const plan = await lockPlan(tx, userId, today);
    await tx
      .delete(planDismissals)
      .where(
        and(eq(planDismissals.userId, userId), eq(planDismissals.planDate, today), eq(planDismissals.taskId, taskId)),
      );
    const existing = await itemsOf(tx, userId, plan.id);
    if (existing.some((i) => i.taskId === taskId)) return;
    if (statuses.get(taskId) !== "open") throw new ConflictError("Only open tasks can be added to the plan");
    await tx
      .insert(planItems)
      .values({ userId, dayPlanId: plan.id, taskId, position: nextPosition(existing), source: "manual" });
  });
}

/** Takes a task out of today's plan; the task itself is untouched. NotFoundError if it isn't in the plan. */
export async function removePlanItem(userId: string, today: IsoDate, taskId: string): Promise<void> {
  assertIsoDate(today, "today");
  await db.transaction(async (tx) => {
    const plan = await findLockedPlan(tx, userId, today);
    if (!plan) throw new NotFoundError("task");
    const deleted = await tx
      .delete(planItems)
      .where(and(eq(planItems.userId, userId), eq(planItems.dayPlanId, plan.id), eq(planItems.taskId, taskId)))
      .returning({ id: planItems.id });
    if (deleted.length === 0) throw new NotFoundError("task");
  });
}

/**
 * Puts today's plan in the order of `taskIds`, which must list exactly the tasks in
 * the plan, each once. NotFoundError if any id isn't the user's task; ConflictError,
 * saving nothing, if the list doesn't match the plan (e.g. it changed in another tab).
 */
export async function reorderPlan(userId: string, today: IsoDate, taskIds: string[]): Promise<void> {
  assertIsoDate(today, "today");
  await db.transaction(async (tx) => {
    await lockOwnTasks(tx, userId, [...new Set(taskIds)]);
    const plan = await findLockedPlan(tx, userId, today);
    const existing = plan ? await itemsOf(tx, userId, plan.id) : [];
    const current = new Map(existing.map((i) => [i.taskId, i.position]));
    const same =
      taskIds.length === current.size &&
      new Set(taskIds).size === taskIds.length &&
      taskIds.every((id) => current.has(id));
    if (!same) throw new ConflictError("Your plan has changed. Reload the page and try again.");
    if (!plan) return;
    for (const [position, taskId] of taskIds.entries()) {
      if (current.get(taskId) === position) continue;
      await tx
        .update(planItems)
        .set({ position })
        .where(and(eq(planItems.userId, userId), eq(planItems.dayPlanId, plan.id), eq(planItems.taskId, taskId)));
    }
  });
}

/** "Not today": hides the task from today's suggestions. NotFoundError if it isn't the user's task. */
export async function dismissSuggestion(userId: string, today: IsoDate, taskId: string): Promise<void> {
  assertIsoDate(today, "today");
  await db.transaction(async (tx) => {
    await lockOwnTasks(tx, userId, [taskId]);
    await tx.insert(planDismissals).values({ userId, planDate: today, taskId }).onConflictDoNothing();
  });
}

/**
 * The status of each of `ids` (distinct), locked against deletion until commit.
 * NotFoundError unless every one is the user's task.
 */
async function lockOwnTasks(tx: Tx, userId: string, ids: string[]): Promise<Map<string, TaskStatus>> {
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)))
    .for("key share");
  if (found.length !== ids.length) throw new NotFoundError("task");
  return new Map(found.map((t) => [t.id, t.status]));
}

/** The user's plan row for `date`, created if missing, locked until commit. */
async function lockPlan(tx: Tx, userId: string, date: IsoDate): Promise<DayPlan> {
  // A concurrent first accept waits on the unique index here, then finds its row below.
  await tx
    .insert(dayPlans)
    .values({ userId, planDate: date })
    .onConflictDoNothing({ target: [dayPlans.userId, dayPlans.planDate] });
  const plan = await findLockedPlan(tx, userId, date);
  if (!plan) throw new Error(`day_plans row missing for ${date}`);
  return plan;
}

async function findLockedPlan(tx: Tx, userId: string, date: IsoDate): Promise<DayPlan | null> {
  const [plan] = await tx
    .select()
    .from(dayPlans)
    .where(and(eq(dayPlans.userId, userId), eq(dayPlans.planDate, date)))
    .for("update");
  return plan ?? null;
}

async function itemsOf(tx: Tx, userId: string, dayPlanId: string) {
  return tx
    .select({ taskId: planItems.taskId, position: planItems.position })
    .from(planItems)
    .where(and(eq(planItems.userId, userId), eq(planItems.dayPlanId, dayPlanId)))
    .orderBy(asc(planItems.position));
}

function nextPosition(items: { position: number }[]): number {
  return items.reduce((max, i) => Math.max(max, i.position + 1), 0);
}
