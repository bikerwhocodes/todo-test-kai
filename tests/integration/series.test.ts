import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { recurringSeries, subtasks, tasks, type Task } from "@/server/db/schema";
import { ConflictError, NotFoundError } from "@/server/repo/errors";
import { createProject, setProjectArchived } from "@/server/repo/projects";
import {
  createSeries,
  deleteSeries,
  getSeriesDetail,
  listDueOccurrences,
  listSeries,
  occurrenceBadges,
  skipOccurrence,
  updateSeries,
} from "@/server/repo/series";
import { addSubtask } from "@/server/repo/subtasks";
import { createTask, deleteTask, getTask, setTaskCompleted, updateTask } from "@/server/repo/tasks";
import type { SeriesRule } from "@/lib/validation";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  createUser,
  expectPgError,
  resetDb,
} from "./helpers";

// Recurring series (spec §7). `today` is passed explicitly, so dates are deterministic.

let userId: string;

beforeEach(async () => {
  await resetDb();
  userId = await createUser("Ada");
});

const daily = (startDate: string, rest: Partial<SeriesRule> = {}): SeriesRule => ({
  kind: "daily",
  interval: 1,
  weekdays: null,
  startDate,
  endDate: null,
  ...rest,
});

/** Every occurrence of the series, oldest first. */
const occurrencesOf = (seriesId: string) =>
  db.select().from(tasks).where(eq(tasks.seriesId, seriesId)).orderBy(asc(tasks.occurrenceDate));

const openOf = async (seriesId: string) => (await occurrencesOf(seriesId)).filter((t) => t.status === "open");

const summary = (rows: Task[]) => rows.map((t) => [t.occurrenceDate, t.status]);

/** A daily series started (and created) on `startDate`; returns its first open occurrence. */
async function dailySeries(startDate: string, rest: Partial<SeriesRule> = {}) {
  const { series, occurrence } = await createSeries(userId, { title: "Water plants", rule: daily(startDate, rest) }, startDate);
  return { series, first: occurrence! };
}

describe("creating a series", () => {
  it("inserts the series and its first occurrence copied from the template, deadline = date", async () => {
    const project = await createProject(userId, { name: "Home" });
    const { series, occurrence } = await createSeries(
      userId,
      {
        title: "Water plants",
        description: "Balcony too",
        priority: 2,
        estimateMin: 10,
        projectId: project.id,
        rule: daily("2026-11-01"),
      },
      "2026-10-22",
    );

    expect(series).toMatchObject({
      userId,
      title: "Water plants",
      description: "Balcony too",
      priority: 2,
      estimateMin: 10,
      projectId: project.id,
      kind: "daily",
      interval: 1,
      weekdays: null,
      startDate: "2026-11-01",
      endDate: null,
    });
    expect(occurrence).toMatchObject({
      userId,
      seriesId: series.id,
      title: "Water plants",
      description: "Balcony too",
      priority: 2,
      estimateMin: 10,
      projectId: project.id,
      status: "open",
      completedAt: null,
      // Start is in the future: the first occurrence is the start date.
      occurrenceDate: "2026-11-01",
      deadline: "2026-11-01",
    });
    expect(summary(await occurrencesOf(series.id))).toEqual([["2026-11-01", "open"]]);
  });

  it("starts at today when the start date is in the past; priority null means none", async () => {
    const { series, occurrence } = await createSeries(
      userId,
      { title: "x", priority: null, rule: daily("2026-10-01", { interval: 3 }) },
      "2026-10-22",
    );
    expect(series.priority).toBe(4);
    // 10-01, 10-04, … 10-19, 10-22.
    expect(occurrence).toMatchObject({ occurrenceDate: "2026-10-22", deadline: "2026-10-22", priority: 4 });
  });

  it("picks the first matching weekday for weekly rules", async () => {
    // 2026-10-22 is a Thursday; the next Monday is 10-26.
    const { series, occurrence } = await createSeries(
      userId,
      { title: "x", rule: { kind: "weekly", interval: 1, weekdays: [1], startDate: "2026-10-22", endDate: null } },
      "2026-10-22",
    );
    expect(series.weekdays).toEqual([1]);
    expect(occurrence!.occurrenceDate).toBe("2026-10-26");
  });

  it("creates no occurrence when the rule has no date left", async () => {
    const { series, occurrence } = await createSeries(
      userId,
      { title: "x", rule: daily("2026-10-01", { endDate: "2026-10-10" }) },
      "2026-10-22",
    );
    expect(occurrence).toBeNull();
    expect(await occurrencesOf(series.id)).toEqual([]);
    expect((await listSeries(userId))[0]).toMatchObject({ id: series.id, open: null });
  });

  it("in an archived or missing project throws NotFoundError and writes nothing", async () => {
    const project = await createProject(userId, { name: "Old" });
    await setProjectArchived(userId, project.id, true);

    await expect(
      createSeries(userId, { title: "x", projectId: project.id, rule: daily("2026-10-22") }, "2026-10-22"),
    ).rejects.toMatchObject({ name: "NotFoundError", entity: "project" });
    await expect(
      createSeries(
        userId,
        { title: "x", projectId: "00000000-0000-4000-8000-000000000000", rule: daily("2026-10-22") },
        "2026-10-22",
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.select().from(recurringSeries)).toEqual([]);
    expect(await db.select().from(tasks)).toEqual([]);
  });
});

describe("completing an occurrence", () => {
  it("marks it done and creates the next occurrence from the series template", async () => {
    const { series, first } = await dailySeries("2026-10-20");
    // Edits to one occurrence stay on it; the next one copies the series template.
    await updateTask(userId, first.id, { title: "Water plants today", priority: 1 });

    const done = await setTaskCompleted(userId, first.id, true, "2026-10-20");

    expect(done).toMatchObject({ id: first.id, status: "done", completedAt: expect.any(Date) });
    const [, next] = await occurrencesOf(series.id);
    expect(next).toMatchObject({
      title: "Water plants",
      priority: 4,
      status: "open",
      occurrenceDate: "2026-10-21",
      deadline: "2026-10-21",
    });
  });

  it("twice in a row leaves exactly one new open occurrence and keeps the first completion", async () => {
    const { series, first } = await dailySeries("2026-10-20");

    const once = await setTaskCompleted(userId, first.id, true, "2026-10-20");
    const twice = await setTaskCompleted(userId, first.id, true, "2026-10-20");

    expect(twice).toEqual(once);
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "done"],
      ["2026-10-21", "open"],
    ]);
  });

  it("concurrently (double submit) leaves exactly one new open occurrence", async () => {
    const { series, first } = await dailySeries("2026-10-20");

    const results = await Promise.all([
      setTaskCompleted(userId, first.id, true, "2026-10-20"),
      setTaskCompleted(userId, first.id, true, "2026-10-20"),
      setTaskCompleted(userId, first.id, true, "2026-10-20"),
    ]);

    expect(results.map((t) => t.status)).toEqual(["done", "done", "done"]);
    expect(new Set(results.map((t) => t.completedAt!.getTime())).size).toBe(1);
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "done"],
      ["2026-10-21", "open"],
    ]);
  });

  it("a skipped occurrence can't be completed", async () => {
    const { series, first } = await dailySeries("2026-10-20");
    await skipOccurrence(userId, first.id, "2026-10-20");

    await expect(setTaskCompleted(userId, first.id, true, "2026-10-20")).rejects.toThrow(
      new ConflictError("This occurrence was skipped"),
    );
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "skipped"],
      ["2026-10-21", "open"],
    ]);
  });

  it("an end date stops generation", async () => {
    const { series, first } = await dailySeries("2026-10-20", { endDate: "2026-10-21" });

    await setTaskCompleted(userId, first.id, true, "2026-10-20");
    const [, last] = await occurrencesOf(series.id);
    expect(last).toMatchObject({ occurrenceDate: "2026-10-21", status: "open" });
    await setTaskCompleted(userId, last!.id, true, "2026-10-21");

    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "done"],
      ["2026-10-21", "done"],
    ]);
    expect((await getSeriesDetail(userId, series.id))!.open).toBeNull();
  });
});

describe("an overdue occurrence", () => {
  it("stays the only open one, reads 'Missed 5 days', and completing it doesn't back-fill", async () => {
    // Created on 10-01; nothing done until 10-06.
    const { series, first } = await dailySeries("2026-10-01");
    const today = "2026-10-06";

    expect(summary(await occurrencesOf(series.id))).toEqual([["2026-10-01", "open"]]);
    const due = await listDueOccurrences(userId, today);
    expect(due.map((t) => t.id)).toEqual([first.id]);
    const badges = await occurrenceBadges(userId, due, today);
    expect(badges.get(first.id)).toEqual({
      seriesId: series.id,
      kind: "daily",
      occurrenceDate: "2026-10-01",
      missedLabel: "Missed 5 days",
    });

    await setTaskCompleted(userId, first.id, true, today);

    // The next occurrence is after today; 10-02 … 10-06 are not created.
    const rows = await occurrencesOf(series.id);
    expect(summary(rows)).toEqual([
      ["2026-10-01", "done"],
      ["2026-10-07", "open"],
    ]);
    const after = await occurrenceBadges(userId, rows, today);
    expect(after.get(rows[0]!.id)!.missedLabel).toBeNull();
    expect(after.get(rows[1]!.id)!.missedLabel).toBeNull();
    expect(await listDueOccurrences(userId, today)).toEqual([]);
  });

  it("badges count missed weekly dates as times and leave one-off tasks out", async () => {
    // Mondays and Thursdays from Mon 10-05; open since 10-05, today Mon 10-19.
    const { occurrence } = await createSeries(
      userId,
      { title: "Gym", rule: { kind: "weekly", interval: 1, weekdays: [1, 4], startDate: "2026-10-05", endDate: null } },
      "2026-10-05",
    );
    const oneOff = await createTask(userId, { title: "x" });

    const badges = await occurrenceBadges(userId, [occurrence!, oneOff], "2026-10-19");
    // 10-05, 10-08, 10-12, 10-15.
    expect(badges.get(occurrence!.id)!.missedLabel).toBe("Missed 4 times");
    expect(badges.has(oneOff.id)).toBe(false);
    expect((await occurrenceBadges(userId, [occurrence!], "2026-10-05")).get(occurrence!.id)!.missedLabel).toBeNull();
  });

  it("listDueOccurrences lists open occurrences due by today, oldest first, with subtasks", async () => {
    const { first: early } = await dailySeries("2026-10-01");
    const { first: late } = await dailySeries("2026-10-03");
    const { first: future } = await dailySeries("2026-10-30");
    await createTask(userId, { title: "one-off" });
    const subtask = await addSubtask(userId, late.id, "Fill the can");

    const due = await listDueOccurrences(userId, "2026-10-05");
    expect(due.map((t) => t.id)).toEqual([early.id, late.id]);
    expect(due[1]!.subtasks.map((s) => s.id)).toEqual([subtask.id]);
    expect(due.map((t) => t.id)).not.toContain(future.id);
  });
});

describe("skipping an occurrence", () => {
  it("marks it skipped (no completed_at) and creates the next one", async () => {
    const { series, first } = await dailySeries("2026-10-20");

    const { skipped, next } = await skipOccurrence(userId, first.id, "2026-10-22");

    expect(skipped).toMatchObject({ id: first.id, status: "skipped", completedAt: null });
    // After today, not after the skipped date.
    expect(next).toMatchObject({ status: "open", occurrenceDate: "2026-10-23", deadline: "2026-10-23" });
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "skipped"],
      ["2026-10-23", "open"],
    ]);
  });

  it("is idempotent, sequentially and concurrently", async () => {
    const { series, first } = await dailySeries("2026-10-20");

    const once = await skipOccurrence(userId, first.id, "2026-10-20");
    const twice = await skipOccurrence(userId, first.id, "2026-10-20");
    expect(twice).toEqual(once);

    const [, second] = await occurrencesOf(series.id);
    const both = await Promise.all([
      skipOccurrence(userId, second!.id, "2026-10-21"),
      skipOccurrence(userId, second!.id, "2026-10-21"),
    ]);
    expect(both[0]).toEqual(both[1]);
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "skipped"],
      ["2026-10-21", "skipped"],
      ["2026-10-22", "open"],
    ]);
  });

  it("refuses done occurrences and one-off tasks", async () => {
    const { first } = await dailySeries("2026-10-20");
    await setTaskCompleted(userId, first.id, true, "2026-10-20");
    const oneOff = await createTask(userId, { title: "x" });

    await expect(skipOccurrence(userId, first.id, "2026-10-20")).rejects.toBeInstanceOf(ConflictError);
    await expect(skipOccurrence(userId, oneOff.id, "2026-10-20")).rejects.toThrow(
      new ConflictError("Only recurring tasks can be skipped"),
    );
    expect((await getTask(userId, first.id))!.status).toBe("done");
    expect((await getTask(userId, oneOff.id))!.status).toBe("open");
    await expect(skipOccurrence(userId, "00000000-0000-4000-8000-000000000000", "2026-10-20")).rejects.toMatchObject({
      entity: "task",
    });
  });
});

describe("series history", () => {
  it("shows completed and skipped dates, latest first, next to the open occurrence", async () => {
    const { series, first } = await dailySeries("2026-10-20");
    await setTaskCompleted(userId, first.id, true, "2026-10-20");
    const [, second] = await occurrencesOf(series.id);
    await skipOccurrence(userId, second!.id, "2026-10-21");

    const detail = await getSeriesDetail(userId, series.id);
    expect(detail).toMatchObject({ id: series.id, title: "Water plants" });
    expect(detail!.history.map((t) => [t.occurrenceDate, t.status, t.completedAt === null])).toEqual([
      ["2026-10-21", "skipped", true],
      ["2026-10-20", "done", false],
    ]);
    expect(detail!.open).toMatchObject({ occurrenceDate: "2026-10-22", status: "open" });
  });

  it("getSeriesDetail is null for missing and malformed ids", async () => {
    expect(await getSeriesDetail(userId, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await getSeriesDetail(userId, "not-a-uuid")).toBeNull();
  });

  it("listSeries orders by title and attaches each open occurrence", async () => {
    const beta = await createSeries(userId, { title: "Beta", rule: daily("2026-10-20") }, "2026-10-20");
    const alpha = await createSeries(userId, { title: "Alpha", rule: daily("2026-10-20", { endDate: "2026-10-20" }) }, "2026-10-20");
    await setTaskCompleted(userId, alpha.occurrence!.id, true, "2026-10-20");

    const list = await listSeries(userId);
    expect(list.map((s) => [s.title, s.open?.id ?? null])).toEqual([
      ["Alpha", null],
      ["Beta", beta.occurrence!.id],
    ]);
  });
});

describe("editing a series", () => {
  /** A series on 10-20 with 10-20 done, 10-21 skipped and 10-22 open (today is 10-22). */
  async function withHistory() {
    const home = await createProject(userId, { name: "Home" });
    const { series, occurrence } = await createSeries(
      userId,
      {
        title: "Water plants",
        description: "Balcony",
        priority: 2,
        estimateMin: 10,
        projectId: home.id,
        rule: daily("2026-10-20"),
      },
      "2026-10-20",
    );
    await setTaskCompleted(userId, occurrence!.id, true, "2026-10-20");
    const [, second] = await occurrencesOf(series.id);
    await skipOccurrence(userId, second!.id, "2026-10-21");
    const rows = await occurrencesOf(series.id);
    return { series, closed: rows.slice(0, 2), open: rows[2]! };
  }

  const closedRows = async (closed: Task[]) =>
    (await db.select().from(tasks).orderBy(asc(tasks.occurrenceDate))).filter((t) => closed.some((c) => c.id === t.id));

  it("template changes update the open occurrence and never the closed ones", async () => {
    const { series, closed, open } = await withHistory();
    const before = await closedRows(closed);
    const work = await createProject(userId, { name: "Work" });

    const updated = await updateSeries(
      userId,
      series.id,
      { title: "Water the plants", description: null, priority: null, estimateMin: 15, projectId: work.id },
      "2026-10-22",
    );

    expect(updated).toMatchObject({
      title: "Water the plants",
      description: null,
      priority: 4,
      estimateMin: 15,
      projectId: work.id,
      // The rule is unchanged.
      kind: "daily",
      startDate: "2026-10-20",
    });
    expect(await getTask(userId, open.id)).toMatchObject({
      title: "Water the plants",
      description: null,
      priority: 4,
      estimateMin: 15,
      projectId: work.id,
      status: "open",
      occurrenceDate: "2026-10-22",
      deadline: "2026-10-22",
    });
    expect(await closedRows(closed)).toEqual(before);
  });

  it("omitted keys are left unchanged on the series and the open occurrence", async () => {
    const { series, open } = await withHistory();
    await updateSeries(userId, series.id, { estimateMin: 20 }, "2026-10-22");
    expect(await getTask(userId, open.id)).toMatchObject({
      title: "Water plants",
      description: "Balcony",
      priority: 2,
      estimateMin: 20,
      projectId: series.projectId,
    });
  });

  it("a rule the open date still fits keeps it", async () => {
    const { series, closed, open } = await withHistory();
    const before = await closedRows(closed);

    // Every other day from 10-20: 10-20, 10-22, …
    await updateSeries(userId, series.id, { rule: daily("2026-10-20", { interval: 2 }) }, "2026-10-22");

    expect(await getTask(userId, open.id)).toMatchObject({ occurrenceDate: "2026-10-22", status: "open" });
    expect(await closedRows(closed)).toEqual(before);
  });

  it("a rule the open date no longer fits moves it to the next fitting date", async () => {
    const { series, closed, open } = await withHistory();
    const before = await closedRows(closed);

    // Mondays only; 10-22 is a Thursday, so the open occurrence moves to Mon 10-26.
    const updated = await updateSeries(
      userId,
      series.id,
      { title: "Weekly water", rule: { kind: "weekly", interval: 1, weekdays: [1], startDate: "2026-10-01", endDate: null } },
      "2026-10-22",
    );

    expect(updated).toMatchObject({ kind: "weekly", weekdays: [1], startDate: "2026-10-01" });
    expect(await getTask(userId, open.id)).toMatchObject({
      title: "Weekly water",
      status: "open",
      occurrenceDate: "2026-10-26",
      deadline: "2026-10-26",
    });
    expect(await closedRows(closed)).toEqual(before);
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "done"],
      ["2026-10-21", "skipped"],
      ["2026-10-26", "open"],
    ]);
  });

  it("never moves the open occurrence onto or before the latest closed date", async () => {
    const { series, closed } = await withHistory();
    const before = await closedRows(closed);

    // Today is 10-21 (e.g. a different zone), but 10-21 is already closed: the next fit is 10-23.
    await updateSeries(userId, series.id, { rule: daily("2026-10-01", { interval: 2 }) }, "2026-10-21");

    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "done"],
      ["2026-10-21", "skipped"],
      ["2026-10-23", "open"],
    ]);
    expect(await closedRows(closed)).toEqual(before);
  });

  it("ending the rule deletes the open occurrence; extending it creates one again", async () => {
    const { series, closed, open } = await withHistory();
    const before = await closedRows(closed);
    await addSubtask(userId, open.id, "Fill the can");

    await updateSeries(userId, series.id, { rule: daily("2026-10-20", { endDate: "2026-10-21" }) }, "2026-10-22");
    expect(await getTask(userId, open.id)).toBeNull();
    expect(await db.select().from(subtasks).where(eq(subtasks.taskId, open.id))).toEqual([]);
    expect(await openOf(series.id)).toEqual([]);

    await updateSeries(userId, series.id, { title: "Back again", rule: daily("2026-10-20") }, "2026-10-24");
    const [reborn] = await openOf(series.id);
    expect(reborn).toMatchObject({
      title: "Back again",
      priority: 2,
      occurrenceDate: "2026-10-24",
      deadline: "2026-10-24",
    });
    expect(await closedRows(closed)).toEqual(before);
  });

  it("moving to an archived project throws NotFoundError and changes nothing", async () => {
    const { series, open } = await withHistory();
    const old = await createProject(userId, { name: "Old" });
    await setProjectArchived(userId, old.id, true);
    const seriesBefore = await db.select().from(recurringSeries).where(eq(recurringSeries.id, series.id));
    const openBefore = await getTask(userId, open.id);

    await expect(updateSeries(userId, series.id, { projectId: old.id, title: "x" }, "2026-10-22")).rejects.toMatchObject({
      entity: "project",
    });
    expect(await db.select().from(recurringSeries).where(eq(recurringSeries.id, series.id))).toEqual(seriesBefore);
    expect(await getTask(userId, open.id)).toEqual(openBefore);

    // Re-sending the current project is allowed even once it is archived.
    await setProjectArchived(userId, series.projectId!, true);
    await expect(
      updateSeries(userId, series.id, { projectId: series.projectId, title: "kept" }, "2026-10-22"),
    ).resolves.toMatchObject({ title: "kept" });
  });

  it("a missing series throws NotFoundError('series')", async () => {
    await expect(
      updateSeries(userId, "00000000-0000-4000-8000-000000000000", { title: "x" }, "2026-10-22"),
    ).rejects.toMatchObject({ name: "NotFoundError", entity: "series" });
  });
});

describe("reopening an occurrence", () => {
  it("is allowed for the latest closed one and removes the occurrence generated from it", async () => {
    const { series, first } = await dailySeries("2026-10-20");
    await setTaskCompleted(userId, first.id, true, "2026-10-20");
    const [, generated] = await occurrencesOf(series.id);
    await addSubtask(userId, generated!.id, "Fill the can");

    const reopened = await setTaskCompleted(userId, first.id, false, "2026-10-20");

    expect(reopened).toMatchObject({ id: first.id, status: "open", completedAt: null });
    expect(summary(await occurrencesOf(series.id))).toEqual([["2026-10-20", "open"]]);
    expect(await db.select().from(subtasks).where(eq(subtasks.taskId, generated!.id))).toEqual([]);

    // Completing it again generates the next one again.
    await setTaskCompleted(userId, first.id, true, "2026-10-20");
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "done"],
      ["2026-10-21", "open"],
    ]);
  });

  it("works for a skipped occurrence and when the series has ended", async () => {
    const { series, first } = await dailySeries("2026-10-20", { endDate: "2026-10-20" });
    await skipOccurrence(userId, first.id, "2026-10-20");
    expect(await openOf(series.id)).toEqual([]);

    const reopened = await setTaskCompleted(userId, first.id, false, "2026-10-20");
    expect(reopened).toMatchObject({ status: "open", completedAt: null });
    expect(summary(await occurrencesOf(series.id))).toEqual([["2026-10-20", "open"]]);
  });

  it("is refused for older occurrences, changing nothing", async () => {
    const { series, first } = await dailySeries("2026-10-20");
    await setTaskCompleted(userId, first.id, true, "2026-10-20");
    const [, second] = await occurrencesOf(series.id);
    await skipOccurrence(userId, second!.id, "2026-10-21");
    const before = await occurrencesOf(series.id);

    await expect(setTaskCompleted(userId, first.id, false, "2026-10-22")).rejects.toThrow(
      new ConflictError("Only the most recent occurrence of a recurring task can be reopened"),
    );
    expect(await occurrencesOf(series.id)).toEqual(before);

    // The latest closed one can still be reopened.
    await setTaskCompleted(userId, second!.id, false, "2026-10-22");
    expect(summary(await occurrencesOf(series.id))).toEqual([
      ["2026-10-20", "done"],
      ["2026-10-21", "open"],
    ]);
  });

  it("an open occurrence is a no-op", async () => {
    const { series, first } = await dailySeries("2026-10-20");
    expect(await setTaskCompleted(userId, first.id, false, "2026-10-20")).toEqual(first);
    expect(summary(await occurrencesOf(series.id))).toEqual([["2026-10-20", "open"]]);
  });
});

describe("deleting", () => {
  it("deleteTask refuses a series occurrence and keeps it", async () => {
    const { first } = await dailySeries("2026-10-20");

    await expect(deleteTask(userId, first.id)).rejects.toThrow(
      new ConflictError("Skip this occurrence or delete the series instead"),
    );
    expect(await getTask(userId, first.id)).not.toBeNull();
  });

  it("deleteSeries removes the series with every occurrence and their subtasks", async () => {
    const { series, first } = await dailySeries("2026-10-20");
    await setTaskCompleted(userId, first.id, true, "2026-10-20");
    const [, open] = await occurrencesOf(series.id);
    await addSubtask(userId, open!.id, "Fill the can");
    const other = await dailySeries("2026-10-20");

    await deleteSeries(userId, series.id);

    expect(await getSeriesDetail(userId, series.id)).toBeNull();
    expect(await occurrencesOf(series.id)).toEqual([]);
    expect(await db.select().from(subtasks)).toEqual([]);
    expect((await listSeries(userId)).map((s) => s.id)).toEqual([other.series.id]);
    await expect(deleteSeries(userId, series.id)).rejects.toMatchObject({ name: "NotFoundError", entity: "series" });
  });

  it("deleteSeries of another user's series throws NotFoundError and keeps it", async () => {
    const { series } = await dailySeries("2026-10-20");
    const other = await createUser("Mallory");

    await expect(deleteSeries(other, series.id)).rejects.toMatchObject({ entity: "series" });
    expect(await openOf(series.id)).toHaveLength(1);
  });
});

describe("database constraints", () => {
  it("allow at most one open occurrence per series", async () => {
    const { series } = await dailySeries("2026-10-20");
    await expectPgError(
      db.insert(tasks).values({ userId, title: "x", seriesId: series.id, occurrenceDate: "2026-10-25" }),
      UNIQUE_VIOLATION,
    );
  });

  it("allow one row per series and date", async () => {
    const { series } = await dailySeries("2026-10-20");
    await expectPgError(
      db.insert(tasks).values({ userId, title: "x", seriesId: series.id, occurrenceDate: "2026-10-20", status: "skipped" }),
      UNIQUE_VIOLATION,
    );
  });

  it("refuse an occurrence that points at another user's series", async () => {
    const { series } = await dailySeries("2026-10-20");
    const other = await createUser("Mallory");
    await expectPgError(
      // Skipped, so the one-open-per-series index can't fire before the foreign key.
      db.insert(tasks).values({
        userId: other,
        title: "x",
        seriesId: series.id,
        occurrenceDate: "2026-10-30",
        status: "skipped",
      }),
      FK_VIOLATION,
    );
  });

  it("require series_id and occurrence_date together", async () => {
    const { series } = await dailySeries("2026-10-20");
    await expectPgError(
      db.insert(tasks).values({ userId, title: "x", seriesId: series.id, status: "skipped" }),
      CHECK_VIOLATION,
    );
    await expectPgError(db.insert(tasks).values({ userId, title: "x", occurrenceDate: "2026-10-30" }), CHECK_VIOLATION);
  });
});
