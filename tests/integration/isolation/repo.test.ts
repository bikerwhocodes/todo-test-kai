import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_QUERY, type SearchQuery } from "@/core/search";
import { db } from "@/server/db";
import { projects, subtasks, taskDependencies, tasks, type Project, type Subtask, type Task } from "@/server/db/schema";
import { addBlocker, blockersFor, removeBlocker } from "@/server/repo/dependencies";
import { NotFoundError } from "@/server/repo/errors";
import {
  createProject,
  getProject,
  listProjects,
  renameProject,
  setProjectArchived,
} from "@/server/repo/projects";
import { searchTasks } from "@/server/repo/search";
import { addSubtask, deleteSubtask, updateSubtask } from "@/server/repo/subtasks";
import {
  createTask,
  deleteTask,
  getTask,
  listInboxTasks,
  listOpenTaskTitles,
  listProjectTasks,
  setTaskCompleted,
  updateTask,
} from "@/server/repo/tasks";
import { CHECK_VIOLATION, FK_VIOLATION, createUser, expectPgError, resetDb } from "../helpers";

// Repo layer: user B must never read or change anything of user A's, through the repo or the database.
// The action, page and route layers are covered next to this file (see ./registry.ts).

let a: string;
let b: string;
let aProject: Project;
let aTask: Task;
let aInboxTask: Task;
let aSubtask: Subtask;

const rowOf = async (table: typeof tasks | typeof projects | typeof subtasks, id: string) =>
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

  it("B cannot update, complete or delete A's task, and A's row is unchanged", async () => {
    const before = await rowOf(tasks, aTask.id);
    const bProject = await createProject(b, { name: "Bob's project" });

    await expect(updateTask(b, aTask.id, { title: "pwned" })).rejects.toMatchObject({ entity: "task" });
    await expect(updateTask(b, aTask.id, { description: null, priority: 1 })).rejects.toBeInstanceOf(NotFoundError);
    // Moving A's task, whether into B's project or A's own, is refused as "task not found".
    await expect(updateTask(b, aTask.id, { projectId: bProject.id })).rejects.toMatchObject({ entity: "task" });
    await expect(updateTask(b, aTask.id, { projectId: aProject.id })).rejects.toMatchObject({ entity: "task" });
    await expect(updateTask(b, aTask.id, { projectId: null })).rejects.toMatchObject({ entity: "task" });
    await expect(setTaskCompleted(b, aTask.id, true)).rejects.toMatchObject({ entity: "task" });
    await expect(deleteTask(b, aTask.id)).rejects.toMatchObject({ entity: "task" });

    expect(await rowOf(tasks, aTask.id)).toEqual(before);
    expect(await rowOf(subtasks, aSubtask.id)).toBeDefined();
  });

  it("B cannot reopen A's completed task", async () => {
    await setTaskCompleted(a, aInboxTask.id, true);
    const before = await rowOf(tasks, aInboxTask.id);

    await expect(setTaskCompleted(b, aInboxTask.id, false)).rejects.toBeInstanceOf(NotFoundError);
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
    // Positive control: A sees the link.
    expect((await getTask(a, aTask.id))!.blockers.map((x) => x.id)).toEqual([aInboxTask.id]);
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

describe("database constraints", () => {
  it("refuse a task owned by B that points at A's project", async () => {
    await expectPgError(db.insert(tasks).values({ userId: b, title: "x", projectId: aProject.id }), FK_VIOLATION);

    const bTask = await createTask(b, { title: "Bob's task" });
    await expectPgError(
      db.update(tasks).set({ projectId: aProject.id }).where(eq(tasks.id, bTask.id)),
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
