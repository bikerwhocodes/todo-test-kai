import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createRepo, NotFoundError } from "../../src/server/repo";
import type { TaskPatch } from "../../src/server/repo/tasks";
import { createUser, pgErrorOf, useTestDb } from "./helpers";

const { db, pool } = useTestDb();
const repo = createRepo(db);

let alice: string;
let bob: string;
let aliceProject: string;
let aliceTask: string;
let aliceSubtask: string;
let bobTask: string;

beforeAll(async () => {
  alice = await createUser(db);
  bob = await createUser(db);
  aliceProject = (await repo.projects.create(alice, { name: "Alice's project" })).id;
  aliceTask = (await repo.tasks.create(alice, { title: "Alice's task", projectId: aliceProject })).id;
  aliceSubtask = (await repo.subtasks.create(alice, aliceTask, { title: "Alice's step" })).id;
  bobTask = (await repo.tasks.create(bob, { title: "Bob's task" })).id;
});

describe("database-level isolation (raw SQL, bypassing the repo)", () => {
  it("allows a task to reference the same user's project", async () => {
    await pool.query(`insert into tasks (user_id, project_id, title) values ($1, $2, 'ok')`, [
      alice,
      aliceProject,
    ]);
  });

  it("rejects inserting a task that references another user's project", async () => {
    const err = await pgErrorOf(() =>
      pool.query(`insert into tasks (user_id, project_id, title) values ($1, $2, 'sneaky')`, [
        bob,
        aliceProject,
      ]),
    );
    expect(err).toMatchObject({ code: "23503", constraint: "tasks_user_project_fk" });
  });

  it("rejects moving a task into another user's project", async () => {
    const err = await pgErrorOf(() =>
      pool.query(`update tasks set project_id = $1 where id = $2`, [aliceProject, bobTask]),
    );
    expect(err).toMatchObject({ code: "23503", constraint: "tasks_user_project_fk" });
  });

  it("rejects a subtask that references another user's task", async () => {
    const err = await pgErrorOf(() =>
      pool.query(`insert into subtasks (user_id, task_id, title) values ($1, $2, 'sneaky')`, [
        bob,
        aliceTask,
      ]),
    );
    expect(err).toMatchObject({ code: "23503", constraint: "subtasks_user_task_fk" });
  });

  it("rejects reassigning a task to another user while it is in a project", async () => {
    const err = await pgErrorOf(() =>
      pool.query(`update tasks set user_id = $1 where id = $2`, [bob, aliceTask]),
    );
    expect(err.code).toBe("23503");
  });
});

describe("repo isolation", () => {
  it("does not read another user's rows", async () => {
    expect(await repo.projects.get(bob, aliceProject)).toBeNull();
    expect(await repo.tasks.get(bob, aliceTask)).toBeNull();
    expect(await repo.projects.list(bob)).toEqual([]);
    expect(await repo.tasks.listByProject(bob, aliceProject)).toEqual([]);
    expect(await repo.subtasks.listForTask(bob, aliceTask)).toEqual([]);
    expect((await repo.tasks.listInbox(bob)).map((t) => t.id)).toEqual([bobTask]);
  });

  it("does not modify or delete another user's rows", async () => {
    expect(await repo.projects.update(bob, aliceProject, { name: "pwned" })).toBeNull();
    expect(await repo.projects.setArchived(bob, aliceProject, true)).toBeNull();
    expect(await repo.projects.remove(bob, aliceProject)).toBe(false);
    expect(await repo.tasks.update(bob, aliceTask, { title: "pwned" })).toBeNull();
    expect(await repo.tasks.setStatus(bob, aliceTask, "done")).toBeNull();
    expect(await repo.tasks.remove(bob, aliceTask)).toBe(false);
    expect(await repo.subtasks.update(bob, aliceSubtask, { done: true })).toBeNull();
    expect(await repo.subtasks.remove(bob, aliceSubtask)).toBe(false);

    expect(await repo.projects.get(alice, aliceProject)).toMatchObject({
      name: "Alice's project",
      archivedAt: null,
    });
    expect(await repo.tasks.get(alice, aliceTask)).toMatchObject({
      title: "Alice's task",
      status: "open",
      projectId: aliceProject,
    });
    expect(await repo.subtasks.listForTask(alice, aliceTask)).toMatchObject([
      { id: aliceSubtask, done: false },
    ]);
  });

  it("reports another user's project or task as not found when linking to it", async () => {
    await expect(
      repo.tasks.create(bob, { title: "x", projectId: aliceProject }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repo.tasks.update(bob, bobTask, { projectId: aliceProject }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.subtasks.create(bob, aliceTask, { title: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Same result as a project id that doesn't exist at all.
    await expect(
      repo.tasks.create(bob, { title: "x", projectId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("ignores userId smuggled into an untyped patch", async () => {
    const patch = { title: "renamed", userId: alice } as TaskPatch;
    const updated = await repo.tasks.update(bob, bobTask, patch);
    expect(updated).toMatchObject({ userId: bob, title: "renamed" });
    expect(await repo.tasks.get(alice, bobTask)).toBeNull();
  });
});

describe("repo behaviour", () => {
  it("moves a deleted project's tasks to the Inbox", async () => {
    const user = await createUser(db);
    const project = await repo.projects.create(user, { name: "Temp" });
    const task = await repo.tasks.create(user, { title: "Keep me", projectId: project.id });

    expect(await repo.projects.remove(user, project.id)).toBe(true);
    expect(await repo.tasks.get(user, task.id)).toMatchObject({ projectId: null });
    expect((await repo.tasks.listInbox(user)).map((t) => t.id)).toEqual([task.id]);
  });

  it("sets and clears completedAt with status", async () => {
    const user = await createUser(db);
    const task = await repo.tasks.create(user, { title: "Do it" });
    const done = await repo.tasks.setStatus(user, task.id, "done");
    expect(done?.completedAt).toBeInstanceOf(Date);
    const reopened = await repo.tasks.setStatus(user, task.id, "open");
    expect(reopened?.completedAt).toBeNull();
  });

  it("cascades a user delete through projects, tasks and subtasks", async () => {
    const user = await createUser(db);
    const project = await repo.projects.create(user, { name: "P" });
    const task = await repo.tasks.create(user, { title: "T", projectId: project.id });
    await repo.subtasks.create(user, task.id, { title: "S" });

    await pool.query(`delete from "user" where id = $1`, [user]);
    const { rows } = await pool.query(
      `select (select count(*) from projects where user_id = $1)::int as p,
              (select count(*) from tasks where user_id = $1)::int as t,
              (select count(*) from subtasks where user_id = $1)::int as s`,
      [user],
    );
    expect(rows[0]).toEqual({ p: 0, t: 0, s: 0 });
  });

  it("allows only one open task per recurring series", async () => {
    const user = await createUser(db);
    const seriesId = randomUUID();
    const insert = (date: string, status = "open") =>
      pool.query(
        `insert into tasks (user_id, title, series_id, occurrence_date, status, completed_at)
         values ($1, 'Recurring', $2, $3, $4, case when $4 = 'open' then null else now() end)`,
        [user, seriesId, date, status],
      );
    await insert("2026-10-20", "done");
    await insert("2026-10-21");
    expect((await pgErrorOf(() => insert("2026-10-22"))).code).toBe("23505");
    expect((await pgErrorOf(() => insert("2026-10-21", "done"))).code).toBe("23505");
  });
});
