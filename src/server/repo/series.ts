import "server-only";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import { addDays, maxIsoDate, type IsoDate, type Weekday } from "@/core/dates";
import {
  missedLabel,
  missedOccurrences,
  nextOccurrenceAfterCompletion,
  occurrenceOnOrAfterDate,
  type RecurrenceRule,
} from "@/core/recurrence";
import { db } from "@/server/db";
import { recurringSeries, tasks, type RecurringSeries, type Task } from "@/server/db/schema";
import { NO_PRIORITY, type SeriesPatch, type SeriesRule } from "@/lib/validation";
import { ConflictError, NotFoundError } from "./errors";
import { assertActiveProject } from "./projects";
// tasks.ts imports this module too; both only use each other inside functions.
import { subtasksFor, type TaskWithSubtasks } from "./tasks";

// Recurring series (spec §7). Every function takes userId first and scopes every
// query by it. `today` is the caller's localToday(settings.timeZone, now).
//
// Writes that touch occurrences lock the series row first (then the occurrence), so
// completing, skipping, reopening and editing one series run one at a time and always
// take their locks in the same order.

export type SeriesWithOpen = RecurringSeries & { open: Task | null };

export type SeriesDetail = SeriesWithOpen & {
  /** Closed occurrences (done and skipped), latest occurrence_date first. */
  history: Task[];
};

/** What a task row shows for an occurrence: the series and the "missed N days" label. */
export type OccurrenceBadge = {
  seriesId: string;
  kind: RecurringSeries["kind"];
  occurrenceDate: IsoDate;
  /** e.g. "Missed 5 days"; null unless the open occurrence is overdue. */
  missedLabel: string | null;
};

export type SeriesTemplate = {
  title: string;
  description?: string | null;
  priority?: number | null;
  estimateMin?: number | null;
  projectId?: string | null;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RuleFields = Pick<RecurringSeries, "kind" | "interval" | "weekdays" | "startDate" | "endDate">;

/** The core rule of a series row (or of a validated SeriesRule, which has the same fields). */
export function toRecurrenceRule(r: RuleFields | SeriesRule): RecurrenceRule {
  return r.kind === "weekly"
    ? {
        kind: "weekly",
        interval: r.interval,
        weekdays: (r.weekdays ?? []) as Weekday[],
        startDate: r.startDate,
        endDate: r.endDate,
      }
    : { kind: "daily", interval: r.interval, startDate: r.startDate, endDate: r.endDate };
}

/** A new open occurrence copied from the series template; its deadline is its date. */
function occurrenceValues(series: RecurringSeries, date: IsoDate): typeof tasks.$inferInsert {
  return {
    userId: series.userId,
    projectId: series.projectId,
    title: series.title,
    description: series.description,
    priority: series.priority,
    estimateMin: series.estimateMin,
    status: "open",
    seriesId: series.id,
    occurrenceDate: date,
    deadline: date,
  };
}

export async function createSeries(
  userId: string,
  input: SeriesTemplate & { rule: SeriesRule },
  today: IsoDate,
): Promise<{ series: RecurringSeries; occurrence: Task | null }> {
  const { rule, projectId = null } = input;
  if (projectId) await assertActiveProject(userId, projectId);
  const date = occurrenceOnOrAfterDate(toRecurrenceRule(rule), maxIsoDate(today, rule.startDate));

  return db.transaction(async (tx) => {
    const [series] = await tx
      .insert(recurringSeries)
      .values({
        userId,
        projectId,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? NO_PRIORITY,
        estimateMin: input.estimateMin ?? null,
        kind: rule.kind,
        interval: rule.interval,
        weekdays: rule.weekdays,
        startDate: rule.startDate,
        endDate: rule.endDate,
      })
      .returning();
    if (!date) return { series: series!, occurrence: null };
    const [occurrence] = await tx.insert(tasks).values(occurrenceValues(series!, date)).returning();
    return { series: series!, occurrence: occurrence! };
  });
}

/**
 * Applies the keys present in `patch` to the template and rule, and the template
 * changes to the open occurrence only. With a new rule, an open occurrence whose
 * date no longer fits moves to the first fitting date after the latest closed one
 * (and not before today); it is deleted when the rule has no date left, or created
 * when there was none. Closed occurrences are never touched.
 */
export async function updateSeries(
  userId: string,
  id: string,
  patch: SeriesPatch,
  today: IsoDate,
): Promise<RecurringSeries> {
  return db.transaction(async (tx) => {
    const current = await lockSeries(tx, userId, id);
    if (!current) throw new NotFoundError("series");
    if (patch.projectId && patch.projectId !== current.projectId) {
      await assertActiveProject(userId, patch.projectId);
    }

    const template: Partial<typeof tasks.$inferInsert> = {};
    if (patch.title !== undefined) template.title = patch.title;
    if (patch.description !== undefined) template.description = patch.description;
    if (patch.priority !== undefined) template.priority = patch.priority ?? NO_PRIORITY;
    if (patch.estimateMin !== undefined) template.estimateMin = patch.estimateMin;
    if (patch.projectId !== undefined) template.projectId = patch.projectId;

    const values: Partial<typeof recurringSeries.$inferInsert> = { ...template, updatedAt: new Date() };
    if (patch.rule) {
      const { kind, interval, weekdays, startDate, endDate } = patch.rule;
      Object.assign(values, { kind, interval, weekdays, startDate, endDate });
    }
    const [series] = await tx
      .update(recurringSeries)
      .set(values)
      .where(and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, id)))
      .returning();

    const [open] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.seriesId, id), eq(tasks.status, "open")))
      .for("update");
    const changes: Partial<typeof tasks.$inferInsert> = { ...template };

    if (patch.rule) {
      const rule = toRecurrenceRule(series!);
      const fits = open && occurrenceOnOrAfterDate(rule, open.occurrenceDate!) === open.occurrenceDate;
      if (!fits) {
        const [lastClosed] = await tx
          .select({ date: tasks.occurrenceDate })
          .from(tasks)
          .where(and(eq(tasks.userId, userId), eq(tasks.seriesId, id), ne(tasks.status, "open")))
          .orderBy(desc(tasks.occurrenceDate))
          .limit(1);
        const from = lastClosed ? maxIsoDate(today, addDays(lastClosed.date!, 1)) : today;
        const date = occurrenceOnOrAfterDate(rule, from);

        if (!open) {
          if (date) await tx.insert(tasks).values(occurrenceValues(series!, date));
          return series!;
        }
        if (!date) {
          await tx.delete(tasks).where(and(eq(tasks.userId, userId), eq(tasks.id, open.id)));
          return series!;
        }
        changes.occurrenceDate = date;
        changes.deadline = date;
      }
    }

    if (open && Object.keys(changes).length > 0) {
      await tx
        .update(tasks)
        .set({ ...changes, updatedAt: new Date() })
        .where(and(eq(tasks.userId, userId), eq(tasks.id, open.id)));
    }
    return series!;
  });
}

/** Deletes the series and (by cascade) all of its occurrences, history included. */
export async function deleteSeries(userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(recurringSeries)
    .where(and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, id)))
    .returning({ id: recurringSeries.id });
  if (deleted.length === 0) throw new NotFoundError("series");
}

/**
 * Marks an open occurrence done and creates the next one (if the rule has one).
 * Completing a done occurrence returns it unchanged and creates nothing, so a
 * double submit leaves exactly one new open occurrence.
 */
export async function completeOccurrence(userId: string, taskId: string, today: IsoDate): Promise<Task> {
  return db.transaction(async (tx) => {
    const { series, occurrence } = await lockOccurrence(tx, userId, taskId, "complete");
    if (occurrence.status === "done") return occurrence;
    if (occurrence.status === "skipped") throw new ConflictError("This occurrence was skipped");
    const [done] = await tx
      .update(tasks)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
      .returning();
    await createNextOccurrence(tx, series, occurrence.occurrenceDate!, today);
    return done!;
  });
}

/**
 * Marks an open occurrence skipped and creates the next one. Skipping a skipped
 * occurrence returns it with the series' current open occurrence.
 */
export async function skipOccurrence(
  userId: string,
  taskId: string,
  today: IsoDate,
): Promise<{ skipped: Task; next: Task | null }> {
  return db.transaction(async (tx) => {
    const { series, occurrence } = await lockOccurrence(tx, userId, taskId, "skip");
    if (occurrence.status === "skipped") {
      return { skipped: occurrence, next: await openOccurrence(tx, userId, series.id) };
    }
    if (occurrence.status === "done") throw new ConflictError("This occurrence is already completed");
    const [skipped] = await tx
      .update(tasks)
      .set({ status: "skipped", completedAt: null, updatedAt: new Date() })
      .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
      .returning();
    const next = await createNextOccurrence(tx, series, occurrence.occurrenceDate!, today);
    return { skipped: skipped!, next };
  });
}

/**
 * Reopens a done or skipped occurrence, only if it is the latest closed one and
 * nothing after it is closed. The open occurrence generated from it (if any) is
 * deleted, so the series still has one open occurrence. Open rows are a no-op.
 */
export async function reopenOccurrence(userId: string, taskId: string): Promise<Task> {
  return db.transaction(async (tx) => {
    const { series, occurrence } = await lockOccurrence(tx, userId, taskId, "reopen");
    if (occurrence.status === "open") return occurrence;
    const date = occurrence.occurrenceDate!;

    // Every other occurrence that is later or open: all must be later and open.
    const others = await tx
      .select({ id: tasks.id, status: tasks.status, occurrenceDate: tasks.occurrenceDate })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.seriesId, series.id),
          ne(tasks.id, taskId),
          or(gt(tasks.occurrenceDate, date), eq(tasks.status, "open")),
        ),
      );
    if (others.some((t) => t.status !== "open" || t.occurrenceDate! < date)) {
      throw new ConflictError("Only the most recent occurrence of a recurring task can be reopened");
    }
    if (others.length > 0) {
      await tx.delete(tasks).where(
        and(
          eq(tasks.userId, userId),
          inArray(
            tasks.id,
            others.map((t) => t.id),
          ),
        ),
      );
    }
    const [reopened] = await tx
      .update(tasks)
      .set({ status: "open", completedAt: null, updatedAt: new Date() })
      .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
      .returning();
    return reopened!;
  });
}

/** Series ordered by title, each with its open occurrence. */
export async function listSeries(userId: string): Promise<SeriesWithOpen[]> {
  const rows = await db
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.userId, userId))
    .orderBy(asc(recurringSeries.title), asc(recurringSeries.id));
  if (rows.length === 0) return [];
  const open = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, "open"),
        inArray(
          tasks.seriesId,
          rows.map((s) => s.id),
        ),
      ),
    );
  const bySeries = new Map(open.map((t) => [t.seriesId!, t]));
  return rows.map((s) => ({ ...s, open: bySeries.get(s.id) ?? null }));
}

/** The series with its open occurrence and history, or null (also for a malformed id). */
export async function getSeriesDetail(userId: string, id: string): Promise<SeriesDetail | null> {
  // A non-uuid id would make Postgres throw; treat it as missing.
  if (!z.uuid().safeParse(id).success) return null;
  const [series] = await db
    .select()
    .from(recurringSeries)
    .where(and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, id)));
  if (!series) return null;
  const occurrences = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.seriesId, id)))
    .orderBy(desc(tasks.occurrenceDate));
  return {
    ...series,
    open: occurrences.find((t) => t.status === "open") ?? null,
    history: occurrences.filter((t) => t.status !== "open"),
  };
}

/** Badges for the series occurrences among `tasks` (one-off tasks are absent from the map). */
export async function occurrenceBadges(
  userId: string,
  tasks: Pick<Task, "id" | "seriesId" | "occurrenceDate" | "status">[],
  today: IsoDate,
): Promise<Map<string, OccurrenceBadge>> {
  const badges = new Map<string, OccurrenceBadge>();
  const occurrences = tasks.filter((t) => t.seriesId && t.occurrenceDate);
  if (occurrences.length === 0) return badges;
  const rows = await db
    .select()
    .from(recurringSeries)
    .where(
      and(
        eq(recurringSeries.userId, userId),
        inArray(recurringSeries.id, [...new Set(occurrences.map((t) => t.seriesId!))]),
      ),
    );
  const byId = new Map(rows.map((s) => [s.id, s]));
  for (const t of occurrences) {
    const series = byId.get(t.seriesId!);
    if (!series) continue;
    const date = t.occurrenceDate!;
    const overdue = t.status === "open" && date < today;
    badges.set(t.id, {
      seriesId: series.id,
      kind: series.kind,
      occurrenceDate: date,
      missedLabel: overdue
        ? missedLabel(series.kind, missedOccurrences(toRecurrenceRule(series), date, today))
        : null,
    });
  }
  return badges;
}

/** Open occurrences due on or before `today`, oldest first, with subtasks (for the Today view). */
export async function listDueOccurrences(userId: string, today: IsoDate): Promise<TaskWithSubtasks[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, "open"),
        isNotNull(tasks.seriesId),
        lte(tasks.occurrenceDate, today),
      ),
    )
    .orderBy(asc(tasks.occurrenceDate), asc(tasks.id));
  const byTask = await subtasksFor(
    userId,
    rows.map((t) => t.id),
  );
  return rows.map((t) => ({ ...t, subtasks: byTask.get(t.id) ?? [] }));
}

async function lockSeries(tx: Tx, userId: string, id: string): Promise<RecurringSeries | null> {
  const [row] = await tx
    .select()
    .from(recurringSeries)
    .where(and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, id)))
    .for("update");
  return row ?? null;
}

/**
 * Locks the occurrence's series and then the occurrence itself. A one-off task is a
 * ConflictError for skip; complete and reopen only route series rows here.
 */
async function lockOccurrence(
  tx: Tx,
  userId: string,
  taskId: string,
  op: "complete" | "skip" | "reopen",
): Promise<{ series: RecurringSeries; occurrence: Task }> {
  const [task] = await tx
    .select({ seriesId: tasks.seriesId })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)));
  if (!task) throw new NotFoundError("task");
  if (!task.seriesId) {
    if (op === "skip") throw new ConflictError("Only recurring tasks can be skipped");
    throw new Error(`${op}Occurrence called on a one-off task`);
  }
  const series = await lockSeries(tx, userId, task.seriesId);
  const [occurrence] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
    .for("update");
  // Either can vanish while we waited for the lock (series deleted, or the row was
  // the generated occurrence a reopen removed).
  if (!series || !occurrence) throw new NotFoundError("task");
  return { series, occurrence };
}

async function openOccurrence(tx: Tx, userId: string, seriesId: string): Promise<Task | null> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.seriesId, seriesId), eq(tasks.status, "open")));
  return row ?? null;
}

/**
 * Inserts the occurrence after the one on `closedDate`, or nothing when the series
 * has ended. ON CONFLICT DO NOTHING backs up the series lock: the database's unique
 * indexes never let a second open occurrence (or a duplicate date) in.
 */
async function createNextOccurrence(
  tx: Tx,
  series: RecurringSeries,
  closedDate: IsoDate,
  today: IsoDate,
): Promise<Task | null> {
  const date = nextOccurrenceAfterCompletion(toRecurrenceRule(series), closedDate, today);
  if (!date) return null;
  const [row] = await tx.insert(tasks).values(occurrenceValues(series, date)).onConflictDoNothing().returning();
  return row ?? (await openOccurrence(tx, series.userId, series.id));
}
