import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_QUERY, type SearchQuery } from "@/core/search";
import { db } from "@/server/db";
import {
  dayPlans,
  planDismissals,
  planItems,
  projects,
  recurringSeries,
  subtasks,
  taskDependencies,
  tasks,
  userSettings,
  type Project,
  type Subtask,
  type Task,
} from "@/server/db/schema";
import { addBlocker, blockersFor, removeBlocker } from "@/server/repo/dependencies";
import { NotFoundError } from "@/server/repo/errors";
import {
  createProject,
  getProject,
  listProjects,
  renameProject,
  setProjectArchived,
} from "@/server/repo/projects";
import { listDueTasks, listUpcomingTasks } from "@/server/repo/agenda";
import {
  acceptSuggestions,
  addPlanItem,
  dismissSuggestion,
  getPlan,
  loadPlanInput,
  removePlanItem,
  reorderPlan,
  suggest,
} from "@/server/repo/plans";
import { searchTasks } from "@/server/repo/search";
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
  listOpenTaskTitles,
  listOpenTasksForPlanning,
  listProjectTasks,
  setTaskCompleted,
  updateTask,
} from "@/server/repo/tasks";
import { getUserSettings, setLastAvailableMin, updateUserSettings } from "@/server/repo/user-settings";
import { CHECK_VIOLATION, FK_VIOLATION, createUser, expectPgError, resetDb } from "../helpers";

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
  // aTask waits on aInboxTask.
  await addBlocker(a, aTask.id, aInboxTask.id);
});

const aEdges = () => db.select().from(taskDependencies).where(eq(taskDependencies.userId, a));

describe("tasks", () => {
  it("B cannot read A's tasks", async () => {
    expect(await getTask(b, aTask.id)).toBeNull();
    expect(await getTask(b, aInboxTask.id)).toBeNull();
    expect(await listInboxTasks(b)).toEqual({ open: [], done: [] });
    expect(await listProjectTasks(b, aProject.id)).toEqual({ open: [], done: [] });
  });

  it("B's Upcoming and due lists hold none of A's tasks", async () => {
    await updateTask(a, aTask.id, { deadline: "2026-10-20" });
    await updateTask(a, aInboxTask.id, { deadline: "2026-10-22" });
    const bTask = await createTask(b, { title: "Bob's task" });
    await updateTask(b, bTask.id, { deadline: "2026-10-22" });

    expect(ids(await listUpcomingTasks(b, "2026-10-22"))).toEqual([bTask.id]);
    expect(ids(await listDueTasks(b, "2026-10-22"))).toEqual([bTask.id]);
    // A's subtasks aren't attached to B's rows either.
    expect((await listDueTasks(b, "2026-10-22"))[0]!.subtasks).toEqual([]);
    expect(ids(await listDueTasks(a, "2026-10-22"))).toEqual([aTask.id, aInboxTask.id]);
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

  it("B's Today and Upcoming lists never include A's dated tasks or occurrences", async () => {
    await updateTask(a, aTask.id, { deadline: "2026-10-22" });
    await updateTask(a, aInboxTask.id, { deadline: "2026-10-24" });
    await createSeries(
      a,
      { title: "Alice's series", rule: { kind: "daily", interval: 1, weekdays: null, startDate: "2026-10-23", endDate: null } },
      TODAY,
    );

    expect(ids(await listDueTasks(a, TODAY))).toEqual([aTask.id]);
    expect(await listUpcomingTasks(a, TODAY)).toHaveLength(3);
    expect(await listDueTasks(b, TODAY)).toEqual([]);
    expect(await listDueTasks(b, "2030-01-01")).toEqual([]);
    expect(await listUpcomingTasks(b, TODAY)).toEqual([]);
    expect(await listUpcomingTasks(b, "2026-10-21")).toEqual([]);
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

describe("task dependencies", () => {
  it("B cannot read A's blockers or pick A's tasks", async () => {
    expect(await blockersFor(b, [aTask.id, aInboxTask.id])).toEqual(new Map());
    expect(await listOpenTaskTitles(b)).toEqual([]);
    expect(await listOpenTasksForPlanning(b)).toEqual([]);
    // Positive control: A sees the link and can pick A's own tasks.
    expect((await getTask(a, aTask.id))!.blockers.map((x) => x.id)).toEqual([aInboxTask.id]);
    expect((await listOpenTasksForPlanning(a)).map((t) => t.id).sort()).toEqual([aTask.id, aInboxTask.id].sort());
  });

  it("B cannot add or remove links on A's tasks, even ones that would close A's loop", async () => {
    const before = await aEdges();
    const bTask = await createTask(b, { title: "Bob's task" });

    for (const [taskId, blockedBy] of [
      [aInboxTask.id, aTask.id], // would close A's loop: must still be "not found"
      [aTask.id, aInboxTask.id], // A's existing link
      [aInboxTask.id, aInboxTask.id],
      [bTask.id, aTask.id],
      [aTask.id, bTask.id],
    ] as const) {
      await expect(addBlocker(b, taskId, blockedBy), `add ${taskId} < ${blockedBy}`).rejects.toMatchObject({
        name: "NotFoundError",
        entity: "task",
      });
    }
    await expect(removeBlocker(b, aTask.id, aInboxTask.id)).rejects.toMatchObject({ entity: "task" });
    await expect(removeBlocker(b, bTask.id, aInboxTask.id)).rejects.toMatchObject({ entity: "task" });

    expect(await aEdges()).toEqual(before);
    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.userId, b))).toEqual([]);
  });

  it("A's lists show A's blockers; B's lists show none of them", async () => {
    expect((await listProjectTasks(a, aProject.id)).open[0]!.blockers).toEqual([
      { id: aInboxTask.id, title: "Alice's inbox task", status: "open" },
    ]);
    const bTask = await createTask(b, { title: "Bob's task" });
    expect((await listInboxTasks(b)).open.map((t) => [t.id, t.blockers])).toEqual([[bTask.id, []]]);
  });
});

describe("search", () => {
  const TODAY = "2030-01-01";
  const query = (q: Partial<SearchQuery>): SearchQuery => ({ ...DEFAULT_SEARCH_QUERY, ...q });

  it("B's searches never return A's tasks, whatever the filters", async () => {
    await updateTask(a, aTask.id, { priority: 1, deadline: "2026-01-01", estimateMin: 5, description: "Alice's notes" });
    const queries: SearchQuery[] = [
      query({}),
      query({ status: "all" }),
      query({ q: "alice", status: "all" }),
      query({ q: "notes", status: "all" }),
      query({ project: aProject.id }),
      query({ project: aProject.id, status: "all" }),
      query({ project: "inbox", status: "all" }),
      query({ priority: 1 }),
      query({ due: "overdue" }),
      query({ due: "has", status: "all" }),
      query({ blocked: true }),
      query({ blocked: false, status: "all" }),
      query({ estimate: true }),
      query({ q: "task", project: aProject.id, priority: 1, due: "overdue", blocked: true, estimate: true }),
    ];
    const bTask = await createTask(b, { title: "Bob's task" });
    for (const q of queries) {
      const { tasks: found } = await searchTasks(b, q, TODAY);
      expect(ids(found).filter((id) => id !== bTask.id), JSON.stringify(q)).toEqual([]);
    }
    // Positive control: A finds the same task with the combined filter.
    expect(ids((await searchTasks(a, queries.at(-1)!, TODAY)).tasks)).toEqual([aTask.id]);
  });

  it("A's open blockers don't make B's tasks blocked", async () => {
    const bTask = await createTask(b, { title: "Bob's task" });
    expect(ids((await searchTasks(b, query({ blocked: true }), TODAY)).tasks)).toEqual([]);
    expect(ids((await searchTasks(b, query({ blocked: false }), TODAY)).tasks)).toEqual([bTask.id]);
    // B's results carry no blockers or subtasks of A's.
    const [found] = (await searchTasks(b, query({}), TODAY)).tasks;
    expect(found).toMatchObject({ id: bTask.id, blockers: [], subtasks: [] });
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

describe("settings", () => {
  it("updating B's settings never touches A's row", async () => {
    const aBefore = await getUserSettings(a);
    await getUserSettings(b);

    const row = await updateUserSettings(b, { timeZone: "Pacific/Kiritimati", defaultEstimateMin: 45 });

    expect(row).toMatchObject({ userId: b, timeZone: "Pacific/Kiritimati", defaultEstimateMin: 45 });
    expect((await db.select().from(userSettings).where(eq(userSettings.userId, a)))[0]).toEqual(aBefore);
  });

  it("remembering B's available time never touches A's row", async () => {
    const aBefore = await getUserSettings(a);

    await setLastAvailableMin(b, 75);

    expect((await getUserSettings(b)).lastAvailableMin).toBe(75);
    expect((await db.select().from(userSettings).where(eq(userSettings.userId, a)))[0]).toEqual(aBefore);
  });
});

describe("day plans", () => {
  /** Every plan row A owns, whole. */
  const aPlanRows = async () => ({
    plans: await db.select().from(dayPlans).where(eq(dayPlans.userId, a)),
    items: await db.select().from(planItems).where(eq(planItems.userId, a)),
    dismissals: await db.select().from(planDismissals).where(eq(planDismissals.userId, a)),
  });
  const bPlanRows = async () => [
    ...(await db.select().from(dayPlans).where(eq(dayPlans.userId, b))),
    ...(await db.select().from(planItems).where(eq(planItems.userId, b))),
    ...(await db.select().from(planDismissals).where(eq(planDismissals.userId, b))),
  ];

  beforeEach(async () => {
    // A planned aInboxTask yesterday and today, and dismissed aTask today.
    await acceptSuggestions(a, "2026-10-21", { taskIds: [aInboxTask.id] });
    await acceptSuggestions(a, TODAY, { taskIds: [aInboxTask.id], availableMin: 90 });
    await dismissSuggestion(a, TODAY, aTask.id);
  });

  it("B cannot read A's plan, dismissals, carried-over tasks or suggestions", async () => {
    expect(await getPlan(b, TODAY)).toEqual({ availableMin: null, items: [] });
    expect(await loadPlanInput(b, TODAY)).toMatchObject({
      tasks: [],
      edges: [],
      inPlanIds: [],
      dismissedIds: [],
      carriedOverIds: [],
    });
    const draft = await suggest(b, TODAY, 1440);
    expect(draft.suggestions).toEqual([]);
    expect(draft.excluded).toEqual([]);
    expect(draft.blocked).toEqual([]);
    expect(draft.totals).toMatchObject({ existingCount: 0, existingMin: 0 });

    // Positive control: A sees all of it.
    expect((await getPlan(a, TODAY)).items.map((i) => i.task.id)).toEqual([aInboxTask.id]);
    expect(await loadPlanInput(a, TODAY)).toMatchObject({
      inPlanIds: [aInboxTask.id],
      dismissedIds: [aTask.id],
      carriedOverIds: [aInboxTask.id],
    });
  });

  it("B's plan holds none of A's tasks, and A's open blockers don't block B's tasks", async () => {
    const bTask = await createTask(b, { title: "Bob's task" });
    await acceptSuggestions(b, TODAY, { taskIds: [bTask.id] });
    expect((await getPlan(b, TODAY)).items.map((i) => i.task.id)).toEqual([bTask.id]);
    expect((await getPlan(b, TODAY)).items[0]!.task).toMatchObject({ subtasks: [], blockers: [] });
    expect(ids((await suggest(b, "2026-10-23", 1440)).suggestions.map((s) => s.task))).toEqual([bTask.id]);
  });

  it("B cannot accept, add, remove, reorder or dismiss A's tasks, and nothing is saved", async () => {
    const before = await aPlanRows();
    const bTask = await createTask(b, { title: "Bob's task" });

    const attempts: [string, () => Promise<unknown>][] = [
      ["accept A's task", () => acceptSuggestions(b, TODAY, { taskIds: [aTask.id] })],
      ["accept B's and A's", () => acceptSuggestions(b, TODAY, { taskIds: [bTask.id, aInboxTask.id], availableMin: 10 })],
      ["add A's task", () => addPlanItem(b, TODAY, aTask.id)],
      ["add A's planned task", () => addPlanItem(b, TODAY, aInboxTask.id)],
      ["remove A's planned task", () => removePlanItem(b, TODAY, aInboxTask.id)],
      ["reorder A's plan", () => reorderPlan(b, TODAY, [aInboxTask.id])],
      ["dismiss A's task", () => dismissSuggestion(b, TODAY, aInboxTask.id)],
      ["re-dismiss A's dismissed task", () => dismissSuggestion(b, TODAY, aTask.id)],
    ];
    for (const [name, run] of attempts) {
      await expect(run(), name).rejects.toMatchObject({ name: "NotFoundError", entity: "task" });
    }

    expect(await aPlanRows()).toEqual(before);
    // Refused writes leave no half-made plan behind for B either.
    expect(await bPlanRows()).toEqual([]);
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

  it("refuse a dependency that joins two users' tasks, whoever owns the row", async () => {
    const bTask = await createTask(b, { title: "Bob's task" });
    const bOther = await createTask(b, { title: "Bob's other task" });
    const cases = [
      { userId: b, taskId: bTask.id, blockedByTaskId: aTask.id },
      { userId: b, taskId: aTask.id, blockedByTaskId: bTask.id },
      { userId: a, taskId: aTask.id, blockedByTaskId: bTask.id },
      { userId: a, taskId: bTask.id, blockedByTaskId: aTask.id },
      // Both tasks A's, row claims B (or the reverse).
      { userId: b, taskId: aInboxTask.id, blockedByTaskId: aTask.id },
      { userId: a, taskId: bTask.id, blockedByTaskId: bOther.id },
    ];
    for (const row of cases) await expectPgError(db.insert(taskDependencies).values(row), FK_VIOLATION);

    // Repointing A's existing row at B's task is refused too.
    await expectPgError(
      db
        .update(taskDependencies)
        .set({ blockedByTaskId: bTask.id })
        .where(and(eq(taskDependencies.userId, a), eq(taskDependencies.taskId, aTask.id))),
      FK_VIOLATION,
    );
    await expectPgError(
      db.update(taskDependencies).set({ userId: b }).where(eq(taskDependencies.userId, a)),
      FK_VIOLATION,
    );
  });

  it("refuse plan rows that join two users' plans and tasks, whoever owns the row", async () => {
    const [aPlan] = await db.insert(dayPlans).values({ userId: a, planDate: TODAY }).returning();
    const [bPlan] = await db.insert(dayPlans).values({ userId: b, planDate: TODAY }).returning();
    const bTask = await createTask(b, { title: "Bob's task" });
    const item = { position: 0, source: "manual" as const };
    const cases = [
      { userId: b, dayPlanId: aPlan!.id, taskId: bTask.id }, // B's row in A's plan
      { userId: b, dayPlanId: bPlan!.id, taskId: aTask.id }, // A's task in B's plan
      { userId: a, dayPlanId: bPlan!.id, taskId: aTask.id }, // A's row in B's plan
      { userId: a, dayPlanId: aPlan!.id, taskId: bTask.id }, // B's task in A's plan
    ];
    for (const row of cases) await expectPgError(db.insert(planItems).values({ ...row, ...item }), FK_VIOLATION);

    for (const row of [
      { userId: b, planDate: TODAY, taskId: aTask.id },
      { userId: a, planDate: TODAY, taskId: bTask.id },
    ]) {
      await expectPgError(db.insert(planDismissals).values(row), FK_VIOLATION);
    }

    // Moving A's existing rows to B, or repointing them at B's rows, is refused too.
    await db.insert(planItems).values({ userId: a, dayPlanId: aPlan!.id, taskId: aTask.id, ...item });
    await db.insert(planDismissals).values({ userId: a, planDate: TODAY, taskId: aTask.id });
    await expectPgError(db.update(planItems).set({ userId: b }).where(eq(planItems.userId, a)), FK_VIOLATION);
    await expectPgError(
      db.update(planItems).set({ dayPlanId: bPlan!.id }).where(eq(planItems.userId, a)),
      FK_VIOLATION,
    );
    await expectPgError(db.update(planItems).set({ taskId: bTask.id }).where(eq(planItems.userId, a)), FK_VIOLATION);
    await expectPgError(db.update(planDismissals).set({ userId: b }).where(eq(planDismissals.userId, a)), FK_VIOLATION);
  });

  it("delete plan items and dismissals with their task", async () => {
    await acceptSuggestions(a, TODAY, { taskIds: [aTask.id, aInboxTask.id] });
    await dismissSuggestion(a, TODAY, aTask.id);
    await deleteTask(a, aTask.id);
    expect((await getPlan(a, TODAY)).items.map((i) => i.task.id)).toEqual([aInboxTask.id]);
    expect(await db.select().from(planDismissals).where(eq(planDismissals.userId, a))).toEqual([]);
  });

  it("refuse a task that waits on itself", async () => {
    await expectPgError(
      db.insert(taskDependencies).values({ userId: a, taskId: aInboxTask.id, blockedByTaskId: aInboxTask.id }),
      CHECK_VIOLATION,
    );
  });

  it("delete a dependency with either of its tasks", async () => {
    const other = await createTask(a, { title: "Alice's other task" });
    await addBlocker(a, other.id, aTask.id);
    expect(await aEdges()).toHaveLength(2);

    await deleteTask(a, aInboxTask.id); // the blocker side of aTask < aInboxTask
    expect((await aEdges()).map((e) => [e.taskId, e.blockedByTaskId])).toEqual([[other.id, aTask.id]]);
    await deleteTask(a, other.id); // the blocked side
    expect(await aEdges()).toEqual([]);
  });
});

function ids(list: { id: string }[]) {
  return list.map((x) => x.id);
}
