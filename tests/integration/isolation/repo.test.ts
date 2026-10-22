import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { projects, subtasks, tasks, type Project, type Subtask, type Task } from "@/server/db/schema";
import { NotFoundError } from "@/server/repo/errors";
import {
  createProject,
  getProject,
  listProjects,
  renameProject,
  setProjectArchived,
} from "@/server/repo/projects";
import { listDueTasks, listUpcomingTasks } from "@/server/repo/agenda";
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
});

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
});

function ids(list: { id: string }[]) {
  return list.map((x) => x.id);
}
