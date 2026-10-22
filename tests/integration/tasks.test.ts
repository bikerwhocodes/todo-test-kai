import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { subtasks, tasks } from "@/server/db/schema";
import { NotFoundError } from "@/server/repo/errors";
import {
  createProject,
  getProject,
  listProjects,
  renameProject,
  setProjectArchived,
} from "@/server/repo/projects";
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
import { CHECK_VIOLATION, createUser, expectPgError, resetDb } from "./helpers";

let userId: string;

beforeEach(async () => {
  await resetDb();
  userId = await createUser("Ada");
});

const ids = (list: { id: string }[]) => list.map((t) => t.id);

describe("creating a task", () => {
  it("with only a title lands in the Inbox with defaults and survives a reload", async () => {
    const task = await createTask(userId, { title: "Buy milk" });

    expect(task).toMatchObject({
      userId,
      title: "Buy milk",
      projectId: null,
      status: "open",
      priority: 4,
      description: null,
      deadline: null,
      estimateMin: null,
      completedAt: null,
    });

    // A fresh query, as a page reload would do.
    const inbox = await listInboxTasks(userId);
    expect(ids(inbox.open)).toEqual([task.id]);
    expect(inbox.done).toEqual([]);
    expect(inbox.open[0]).toMatchObject({ title: "Buy milk", subtasks: [] });
  });

  it("in a project lists under that project, not the Inbox", async () => {
    const project = await createProject(userId, { name: "Home" });
    const task = await createTask(userId, { title: "Fix tap", projectId: project.id });

    expect(task.projectId).toBe(project.id);
    expect(ids((await listProjectTasks(userId, project.id)).open)).toEqual([task.id]);
    expect((await listInboxTasks(userId)).open).toEqual([]);
  });

  it("in an archived project throws NotFoundError", async () => {
    const project = await createProject(userId, { name: "Old" });
    await setProjectArchived(userId, project.id, true);

    await expect(createTask(userId, { title: "x", projectId: project.id })).rejects.toMatchObject({
      name: "NotFoundError",
      entity: "project",
    });
  });

  it("in a missing project throws NotFoundError", async () => {
    await expect(
      createTask(userId, { title: "x", projectId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("editing a task", () => {
  it.each([
    { field: "description", value: "Two litres, semi-skimmed", cleared: null },
    { field: "priority", value: 1, cleared: 4 },
    { field: "deadline", value: "2026-11-05", cleared: null },
    { field: "estimateMin", value: 25, cleared: null },
  ] as const)("sets and clears $field", async ({ field, value, cleared }) => {
    const task = await createTask(userId, { title: "Buy milk" });

    const set = await updateTask(userId, task.id, { [field]: value });
    expect(set[field]).toBe(value);
    expect((await getTask(userId, task.id))![field]).toBe(value);

    const clear = await updateTask(userId, task.id, { [field]: null });
    expect(clear[field]).toBe(cleared);
    expect((await getTask(userId, task.id))![field]).toBe(cleared);
  });

  it("sets and clears projectId (moves to a project and back to the Inbox)", async () => {
    const project = await createProject(userId, { name: "Home" });
    const task = await createTask(userId, { title: "Fix tap" });

    await updateTask(userId, task.id, { projectId: project.id });
    expect((await getTask(userId, task.id))!.projectId).toBe(project.id);
    expect((await listInboxTasks(userId)).open).toEqual([]);

    await updateTask(userId, task.id, { projectId: null });
    expect((await getTask(userId, task.id))!.projectId).toBeNull();
    expect(ids((await listInboxTasks(userId)).open)).toEqual([task.id]);
  });

  it("round-trips the deadline as the exact YYYY-MM-DD string", async () => {
    const task = await createTask(userId, { title: "File taxes" });
    await updateTask(userId, task.id, { deadline: "2027-01-01" });
    const reloaded = await getTask(userId, task.id);
    expect(reloaded!.deadline).toBe("2027-01-01");
    expect(typeof reloaded!.deadline).toBe("string");
  });

  it("leaves omitted keys untouched", async () => {
    const project = await createProject(userId, { name: "Home" });
    const task = await createTask(userId, { title: "Fix tap", projectId: project.id });
    await updateTask(userId, task.id, {
      description: "Kitchen",
      priority: 2,
      deadline: "2026-12-01",
      estimateMin: 30,
    });

    const updated = await updateTask(userId, task.id, { title: "Fix kitchen tap" });
    expect(updated).toMatchObject({
      title: "Fix kitchen tap",
      description: "Kitchen",
      priority: 2,
      deadline: "2026-12-01",
      estimateMin: 30,
      projectId: project.id,
    });
  });

  it("moving into an archived project throws NotFoundError and leaves the task where it was", async () => {
    const archived = await createProject(userId, { name: "Old" });
    await setProjectArchived(userId, archived.id, true);
    const task = await createTask(userId, { title: "x" });

    await expect(updateTask(userId, task.id, { projectId: archived.id })).rejects.toMatchObject({
      name: "NotFoundError",
      entity: "project",
    });
    expect((await getTask(userId, task.id))!.projectId).toBeNull();
  });

  it("moving from one project into a different archived project throws NotFoundError", async () => {
    const active = await createProject(userId, { name: "Active" });
    const archived = await createProject(userId, { name: "Old" });
    await setProjectArchived(userId, archived.id, true);
    const task = await createTask(userId, { title: "x", projectId: active.id });

    await expect(updateTask(userId, task.id, { projectId: archived.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTask(userId, task.id))!.projectId).toBe(active.id);
  });

  it("works on a task whose project was archived when projectId is re-sent unchanged", async () => {
    const project = await createProject(userId, { name: "Home" });
    const task = await createTask(userId, { title: "Fix tap", projectId: project.id });
    await setProjectArchived(userId, project.id, true);

    const updated = await updateTask(userId, task.id, { title: "Fix kitchen tap", projectId: project.id });
    expect(updated).toMatchObject({ title: "Fix kitchen tap", projectId: project.id });

    // Edits that don't mention the project also work.
    expect((await updateTask(userId, task.id, { priority: 1 })).priority).toBe(1);
  });

  it("a missing task throws NotFoundError", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(updateTask(userId, missing, { title: "x" })).rejects.toMatchObject({ entity: "task" });
    const project = await createProject(userId, { name: "Home" });
    await expect(updateTask(userId, missing, { projectId: project.id })).rejects.toMatchObject({ entity: "task" });
  });
});

describe("completing and reopening", () => {
  it("complete sets status done and completedAt", async () => {
    const task = await createTask(userId, { title: "x" });
    const done = await setTaskCompleted(userId, task.id, true);
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it("completing an already-done task keeps the original completedAt", async () => {
    const task = await createTask(userId, { title: "x" });
    await setTaskCompleted(userId, task.id, true);
    const original = new Date("2026-01-15T09:30:00Z");
    await db.update(tasks).set({ completedAt: original }).where(eq(tasks.id, task.id));

    const again = await setTaskCompleted(userId, task.id, true);
    expect(again.status).toBe("done");
    expect(again.completedAt).toEqual(original);
  });

  it("reopen sets status open and clears completedAt", async () => {
    const task = await createTask(userId, { title: "x" });
    await setTaskCompleted(userId, task.id, true);

    const reopened = await setTaskCompleted(userId, task.id, false);
    expect(reopened).toMatchObject({ status: "open", completedAt: null });
    expect(await getTask(userId, task.id)).toMatchObject({ status: "open", completedAt: null });
  });

  it("completing after reopening stamps a fresh completedAt", async () => {
    const task = await createTask(userId, { title: "x" });
    await setTaskCompleted(userId, task.id, true);
    await setTaskCompleted(userId, task.id, false);
    const again = await setTaskCompleted(userId, task.id, true);
    expect(again.completedAt).toBeInstanceOf(Date);
  });

  it("the database rejects status/completed_at mismatches", async () => {
    await expectPgError(db.insert(tasks).values({ userId, title: "x", status: "done" }), CHECK_VIOLATION);
    await expectPgError(
      db.insert(tasks).values({ userId, title: "x", status: "open", completedAt: new Date() }),
      CHECK_VIOLATION,
    );

    const task = await createTask(userId, { title: "x" });
    await expectPgError(db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id)), CHECK_VIOLATION);
    await setTaskCompleted(userId, task.id, true);
    await expectPgError(db.update(tasks).set({ status: "open" }).where(eq(tasks.id, task.id)), CHECK_VIOLATION);
  });
});

describe("deleting a task", () => {
  it("removes the task and its subtasks", async () => {
    const task = await createTask(userId, { title: "x" });
    await addSubtask(userId, task.id, "a");
    await addSubtask(userId, task.id, "b");

    await deleteTask(userId, task.id);

    expect(await getTask(userId, task.id)).toBeNull();
    expect(await db.select().from(subtasks).where(eq(subtasks.taskId, task.id))).toEqual([]);
    expect((await listInboxTasks(userId)).open).toEqual([]);
  });

  it("throws NotFoundError for a missing task", async () => {
    const task = await createTask(userId, { title: "x" });
    await deleteTask(userId, task.id);
    await expect(deleteTask(userId, task.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("task lists", () => {
  it("list open tasks oldest first and completed tasks latest-completed first", async () => {
    const [a, b, c, d, e] = await Promise.all(
      ["a", "b", "c", "d", "e"].map((title) => createTask(userId, { title })),
    );
    const at = (iso: string) => new Date(iso);
    await db.update(tasks).set({ createdAt: at("2026-01-03T00:00:00Z") }).where(eq(tasks.id, a!.id));
    await db.update(tasks).set({ createdAt: at("2026-01-01T00:00:00Z") }).where(eq(tasks.id, b!.id));
    await db.update(tasks).set({ createdAt: at("2026-01-02T00:00:00Z") }).where(eq(tasks.id, c!.id));

    await setTaskCompleted(userId, d!.id, true);
    await setTaskCompleted(userId, e!.id, true);
    await db.update(tasks).set({ completedAt: at("2026-02-01T00:00:00Z") }).where(eq(tasks.id, d!.id));
    await db.update(tasks).set({ completedAt: at("2026-02-05T00:00:00Z") }).where(eq(tasks.id, e!.id));

    const inbox = await listInboxTasks(userId);
    expect(ids(inbox.open)).toEqual([b!.id, c!.id, a!.id]);
    expect(ids(inbox.done)).toEqual([e!.id, d!.id]);
    expect(inbox.done.every((t) => t.status === "done")).toBe(true);
  });

  it("separate the Inbox from projects and projects from each other", async () => {
    const home = await createProject(userId, { name: "Home" });
    const work = await createProject(userId, { name: "Work" });
    const inboxTask = await createTask(userId, { title: "inbox" });
    const homeTask = await createTask(userId, { title: "home", projectId: home.id });
    const workTask = await createTask(userId, { title: "work", projectId: work.id });
    await setTaskCompleted(userId, workTask.id, true);

    const inbox = await listInboxTasks(userId);
    expect(ids(inbox.open)).toEqual([inboxTask.id]);
    expect(inbox.done).toEqual([]);

    const homeList = await listProjectTasks(userId, home.id);
    expect(ids(homeList.open)).toEqual([homeTask.id]);
    expect(homeList.done).toEqual([]);

    const workList = await listProjectTasks(userId, work.id);
    expect(workList.open).toEqual([]);
    expect(ids(workList.done)).toEqual([workTask.id]);
  });
});

describe("subtasks", () => {
  it("are appended in order, toggled, renamed and deleted", async () => {
    const task = await createTask(userId, { title: "Pack" });
    const s1 = await addSubtask(userId, task.id, "Socks");
    const s2 = await addSubtask(userId, task.id, "Shirts");
    const s3 = await addSubtask(userId, task.id, "Shoes");
    expect([s1.sort, s2.sort, s3.sort]).toEqual([0, 1, 2]);
    expect(s1.done).toBe(false);

    expect((await updateSubtask(userId, s2.id, { done: true })).done).toBe(true);
    expect((await updateSubtask(userId, s3.id, { title: "Boots" })).title).toBe("Boots");
    // An empty patch returns the row unchanged.
    expect(await updateSubtask(userId, s2.id, {})).toMatchObject({ title: "Shirts", done: true });
    expect((await updateSubtask(userId, s2.id, { done: false })).done).toBe(false);

    await deleteSubtask(userId, s1.id);
    await expect(deleteSubtask(userId, s1.id)).rejects.toMatchObject({ entity: "subtask" });

    const reloaded = await getTask(userId, task.id);
    expect(reloaded!.subtasks.map((s) => [s.title, s.done])).toEqual([
      ["Shirts", false],
      ["Boots", false],
    ]);

    // Sort keeps increasing after a delete.
    expect((await addSubtask(userId, task.id, "Hat")).sort).toBe(3);
  });

  it("are listed with their own task in task lists", async () => {
    const t1 = await createTask(userId, { title: "one" });
    const t2 = await createTask(userId, { title: "two" });
    await addSubtask(userId, t1.id, "1a");
    await addSubtask(userId, t2.id, "2a");
    await addSubtask(userId, t1.id, "1b");

    const { open } = await listInboxTasks(userId);
    const byId = new Map(open.map((t) => [t.id, t.subtasks.map((s) => s.title)]));
    expect(byId.get(t1.id)).toEqual(["1a", "1b"]);
    expect(byId.get(t2.id)).toEqual(["2a"]);
  });

  it("cannot be added to a missing task", async () => {
    await expect(addSubtask(userId, "00000000-0000-4000-8000-000000000000", "x")).rejects.toMatchObject({
      entity: "task",
    });
  });
});

describe("projects", () => {
  it("are created, renamed, archived and unarchived", async () => {
    const project = await createProject(userId, { name: "Home" });
    expect(project).toMatchObject({ userId, name: "Home", archivedAt: null });

    expect((await renameProject(userId, project.id, "House")).name).toBe("House");
    expect((await getProject(userId, project.id))!.name).toBe("House");

    const archived = await setProjectArchived(userId, project.id, true);
    expect(archived.archivedAt).toBeInstanceOf(Date);

    const unarchived = await setProjectArchived(userId, project.id, false);
    expect(unarchived.archivedAt).toBeNull();
    expect(ids(await listProjects(userId))).toEqual([project.id]);
  });

  it("archiving keeps the project's tasks", async () => {
    const project = await createProject(userId, { name: "Home" });
    const task = await createTask(userId, { title: "x", projectId: project.id });
    await setProjectArchived(userId, project.id, true);

    expect(await getTask(userId, task.id)).not.toBeNull();
    expect(ids((await listProjectTasks(userId, project.id)).open)).toEqual([task.id]);
  });

  it("listProjects hides archived projects unless includeArchived", async () => {
    const home = await createProject(userId, { name: "Home" });
    const old = await createProject(userId, { name: "Old" });
    await setProjectArchived(userId, old.id, true);

    expect(ids(await listProjects(userId))).toEqual([home.id]);
    expect(new Set(ids(await listProjects(userId, { includeArchived: true })))).toEqual(
      new Set([home.id, old.id]),
    );
  });

  it("rename/archive of a missing project throws NotFoundError", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(renameProject(userId, missing, "x")).rejects.toMatchObject({ entity: "project" });
    await expect(setProjectArchived(userId, missing, true)).rejects.toMatchObject({ entity: "project" });
  });
});
