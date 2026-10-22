import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { projects, recurringSeries, subtasks, tasks, type Project, type Subtask, type Task } from "@/server/db/schema";
import { NotFoundError } from "@/server/repo/errors";
import {
  createProject,
  getProject,
  listProjects,
  renameProject,
  setProjectArchived,
} from "@/server/repo/projects";
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
import { addSubtask, deleteSubtask, updateSubtask } from "@/server/repo/subtasks";
import {
  createTask,
  deleteTask,
  getTask,
  listInboxTasks,
  listProjectTasks,
  setTaskCompleted,
  updateTask,
} from "@/server/repo/tasks";
import { FK_VIOLATION, createUser, expectPgError, resetDb } from "../helpers";

// Repo layer: user B must never read or change anything of user A's, through the repo or the database.
// The action, page and route layers are covered next to this file (see ./registry.ts).

let a: string;
let b: string;
let aProject: Project;
let aTask: Task;
let aInboxTask: Task;
let aSubtask: Subtask;

const TODAY = "2026-10-22";

const rowOf = async (table: typeof tasks | typeof projects | typeof subtasks | typeof recurringSeries, id: string) =>
  (await db.select().from(table).where(eq(table.id, id)))[0];

beforeEach(async () => {
  await resetDb();
  a = await createUser("Alice");
  b = await createUser("Bob");
  aProject = await createProject(a, { name: "Alice's project" });
  aTask = await createTask(a, { title: "Alice's task", projectId: aProject.id });
  aInboxTask = await createTask(a, { title: "Alice's inbox task" });
  aSubtask = await addSubtask(a, aTask.id, "Alice's subtask");
});

describe("tasks", () => {
  it("B cannot read A's tasks", async () => {
    expect(await getTask(b, aTask.id)).toBeNull();
    expect(await getTask(b, aInboxTask.id)).toBeNull();
    expect(await listInboxTasks(b)).toEqual({ open: [], done: [] });
    expect(await listProjectTasks(b, aProject.id)).toEqual({ open: [], done: [] });
  });

  it("B cannot update, complete or delete A's task, and A's row is unchanged", async () => {
    const before = await rowOf(tasks, aTask.id);
    const bProject = await createProject(b, { name: "Bob's project" });

    await expect(updateTask(b, aTask.id, { title: "pwned" })).rejects.toMatchObject({ entity: "task" });
    await expect(updateTask(b, aTask.id, { description: null, priority: 1 })).rejects.toBeInstanceOf(NotFoundError);
    // Moving A's task, whether into B's project or A's own, is refused as "task not found".
    await expect(updateTask(b, aTask.id, { projectId: bProject.id })).rejects.toMatchObject({ entity: "task" });
    await expect(updateTask(b, aTask.id, { projectId: aProject.id })).rejects.toMatchObject({ entity: "task" });
    await expect(updateTask(b, aTask.id, { projectId: null })).rejects.toMatchObject({ entity: "task" });
    await expect(setTaskCompleted(b, aTask.id, true, TODAY)).rejects.toMatchObject({ entity: "task" });
    await expect(deleteTask(b, aTask.id)).rejects.toMatchObject({ entity: "task" });

    expect(await rowOf(tasks, aTask.id)).toEqual(before);
    expect(await rowOf(subtasks, aSubtask.id)).toBeDefined();
  });

  it("B cannot reopen A's completed task", async () => {
    await setTaskCompleted(a, aInboxTask.id, true, TODAY);
    const before = await rowOf(tasks, aInboxTask.id);

    await expect(setTaskCompleted(b, aInboxTask.id, false, TODAY)).rejects.toBeInstanceOf(NotFoundError);
    expect(await rowOf(tasks, aInboxTask.id)).toEqual(before);
  });

  it("B cannot create a task in, or move a task into, A's project", async () => {
    await expect(createTask(b, { title: "x", projectId: aProject.id })).rejects.toMatchObject({
      entity: "project",
    });

    const bTask = await createTask(b, { title: "Bob's task" });
    await expect(updateTask(b, bTask.id, { projectId: aProject.id })).rejects.toMatchObject({
      entity: "project",
    });
    expect((await getTask(b, bTask.id))!.projectId).toBeNull();
    expect(ids((await listProjectTasks(a, aProject.id)).open)).toEqual([aTask.id]);
  });
});

describe("subtasks", () => {
  it("B cannot add, update or delete subtasks on A's task", async () => {
    const before = await rowOf(subtasks, aSubtask.id);

    await expect(addSubtask(b, aTask.id, "x")).rejects.toMatchObject({ entity: "task" });
    await expect(updateSubtask(b, aSubtask.id, { done: true })).rejects.toMatchObject({ entity: "subtask" });
    await expect(updateSubtask(b, aSubtask.id, { title: "pwned" })).rejects.toMatchObject({ entity: "subtask" });
    await expect(updateSubtask(b, aSubtask.id, {})).rejects.toMatchObject({ entity: "subtask" });
    await expect(deleteSubtask(b, aSubtask.id)).rejects.toMatchObject({ entity: "subtask" });

    expect(await rowOf(subtasks, aSubtask.id)).toEqual(before);
    expect((await getTask(a, aTask.id))!.subtasks.map((s) => s.id)).toEqual([aSubtask.id]);
  });
});

describe("projects", () => {
  it("B cannot see, rename or archive A's project", async () => {
    const before = await rowOf(projects, aProject.id);

    expect(await getProject(b, aProject.id)).toBeNull();
    expect(await listProjects(b)).toEqual([]);
    expect(await listProjects(b, { includeArchived: true })).toEqual([]);
    await expect(renameProject(b, aProject.id, "pwned")).rejects.toMatchObject({ entity: "project" });
    await expect(setProjectArchived(b, aProject.id, true)).rejects.toMatchObject({ entity: "project" });

    expect(await rowOf(projects, aProject.id)).toEqual(before);
  });

  it("each user lists only their own projects", async () => {
    const bProject = await createProject(b, { name: "Bob's project" });
    expect(ids(await listProjects(a))).toEqual([aProject.id]);
    expect(ids(await listProjects(b))).toEqual([bProject.id]);
  });
});

describe("recurring series", () => {
  const daily = { kind: "daily" as const, interval: 1, weekdays: null, startDate: "2026-10-01", endDate: null };

  it("B cannot read, edit, skip, complete, reopen or delete A's series and occurrences", async () => {
    const { series, occurrence } = await createSeries(a, { title: "Alice's series", projectId: aProject.id, rule: daily }, "2026-10-20");
    const done = await setTaskCompleted(a, occurrence!.id, true, "2026-10-20");
    const open = (await getSeriesDetail(a, series.id))!.open!;
    const seriesBefore = await rowOf(recurringSeries, series.id);
    const doneBefore = await rowOf(tasks, done.id);
    const openBefore = await rowOf(tasks, open.id);
    const bProject = await createProject(b, { name: "Bob's project" });

    expect(await listSeries(b)).toEqual([]);
    expect(await getSeriesDetail(b, series.id)).toBeNull();
    expect(await listDueOccurrences(b, "2030-01-01")).toEqual([]);
    expect((await occurrenceBadges(b, [open], "2030-01-01")).size).toBe(0);

    await expect(updateSeries(b, series.id, { title: "pwned" }, TODAY)).rejects.toMatchObject({ entity: "series" });
    await expect(updateSeries(b, series.id, { projectId: bProject.id }, TODAY)).rejects.toMatchObject({ entity: "series" });
    await expect(updateSeries(b, series.id, { rule: { ...daily, interval: 2 } }, TODAY)).rejects.toMatchObject({
      entity: "series",
    });
    await expect(deleteSeries(b, series.id)).rejects.toMatchObject({ entity: "series" });
    await expect(skipOccurrence(b, open.id, TODAY)).rejects.toMatchObject({ entity: "task" });
    await expect(setTaskCompleted(b, open.id, true, TODAY)).rejects.toMatchObject({ entity: "task" });
    await expect(setTaskCompleted(b, done.id, false, TODAY)).rejects.toMatchObject({ entity: "task" });
    await expect(deleteTask(b, open.id)).rejects.toMatchObject({ entity: "task" });
    await expect(updateTask(b, open.id, { title: "pwned" })).rejects.toMatchObject({ entity: "task" });

    expect(await rowOf(recurringSeries, series.id)).toEqual(seriesBefore);
    expect(await rowOf(tasks, done.id)).toEqual(doneBefore);
    expect(await rowOf(tasks, open.id)).toEqual(openBefore);
  });

  it("B cannot create a series in, or move B's series into, A's project", async () => {
    await expect(createSeries(b, { title: "x", projectId: aProject.id, rule: daily }, TODAY)).rejects.toMatchObject({
      entity: "project",
    });
    expect(await listSeries(b)).toEqual([]);

    const { series } = await createSeries(b, { title: "Bob's series", rule: daily }, TODAY);
    await expect(updateSeries(b, series.id, { projectId: aProject.id }, TODAY)).rejects.toMatchObject({
      entity: "project",
    });
    expect((await getSeriesDetail(b, series.id))!.projectId).toBeNull();
  });
});

describe("database constraints", () => {
  it("refuse a task owned by B that points at A's project", async () => {
    await expectPgError(db.insert(tasks).values({ userId: b, title: "x", projectId: aProject.id }), FK_VIOLATION);

    const bTask = await createTask(b, { title: "Bob's task" });
    await expectPgError(
      db.update(tasks).set({ projectId: aProject.id }).where(eq(tasks.id, bTask.id)),
      FK_VIOLATION,
    );
  });

  it("refuse an occurrence owned by B in A's series", async () => {
    const { series } = await createSeries(
      a,
      { title: "Alice's series", rule: { kind: "daily", interval: 1, weekdays: null, startDate: TODAY, endDate: null } },
      TODAY,
    );
    await expectPgError(
      // Skipped, so the one-open-per-series index can't fire before the foreign key.
      db.insert(tasks).values({ userId: b, title: "x", seriesId: series.id, occurrenceDate: "2030-01-01", status: "skipped" }),
      FK_VIOLATION,
    );
  });

  it("refuse a subtask owned by B under A's task", async () => {
    await expectPgError(db.insert(subtasks).values({ userId: b, taskId: aTask.id, title: "x" }), FK_VIOLATION);
  });
});

function ids(list: { id: string }[]) {
  return list.map((x) => x.id);
}
