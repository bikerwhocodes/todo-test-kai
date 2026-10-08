// AT-33/36/37 — account isolation at the APPLICATION layer.
//
// NEXT-1 already proved the database half: raw SQL under the runtime role
// cannot read or forge another owner's rows, and identity does not leak across
// a pooled connection (tests/rls.test.ts). Those are not re-proven here.
//
// This file covers what only exists once auth is wired: two real signed-in
// accounts driving the real route handlers, where the answer for someone
// else's id must be 404 — never 403, never 200, never a 500 whose message
// confirms the row exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { superPool } from "./helpers.ts";
import { anonymous, authed, codeOf, params, signUpTwo } from "./auth-helpers.ts";

import { GET as listProjects, POST as createProject } from "../src/app/api/projects/route.ts";
import {
  DELETE as deleteProject, GET as getProject, PATCH as patchProject,
} from "../src/app/api/projects/[id]/route.ts";
import { GET as listTasks, POST as createTask } from "../src/app/api/tasks/route.ts";
import { DELETE as deleteTask, GET as getTask, PATCH as patchTask } from "../src/app/api/tasks/[id]/route.ts";
import { POST as linkDependency } from "../src/app/api/tasks/[id]/dependencies/route.ts";
import { GET as getMe, PATCH as patchMe } from "../src/app/api/me/route.ts";

const json = async (res: Response) => res.json() as Promise<Record<string, any>>;

/** A owns a project and a task; B is a signed-in stranger. */
async function twoAccountsWithData() {
  const [a, b] = await signUpTwo();
  const project = (await json(await createProject(
    authed("/api/projects", a, { method: "POST", body: JSON.stringify({ name: "A's project" }) }),
  ))).project;
  const task = (await json(await createTask(
    authed("/api/tasks", a, {
      method: "POST",
      body: JSON.stringify({ title: "A's task", projectId: project.id, deadline: "2026-12-01" }),
    }),
  ))).task;
  return { a, b, project, task };
}

test("A2: each account sees only its own rows in every list", async () => {
  const { a, b, project, task } = await twoAccountsWithData();

  const aProjects = (await json(await listProjects(authed("/api/projects", a)))).projects;
  const bProjects = (await json(await listProjects(authed("/api/projects", b)))).projects;
  assert.deepEqual(aProjects.map((p: any) => p.id), [project.id]);
  assert.deepEqual(bProjects, [], "B must not see A's project");

  const aTasks = (await json(await listTasks(authed("/api/tasks", a)))).tasks;
  const bTasks = (await json(await listTasks(authed("/api/tasks", b)))).tasks;
  assert.deepEqual(aTasks.map((t: any) => t.id), [task.id]);
  assert.deepEqual(bTasks, [], "B must not see A's task");
});

test("A3: reading another account's id returns 404 — never 403, never 200", async () => {
  const { b, project, task } = await twoAccountsWithData();

  const p = await getProject(authed(`/api/projects/${project.id}`, b), params(project.id));
  assert.equal(p.status, 404, "a 403 here would confirm the row exists");
  assert.equal(await codeOf(p), "NOT_FOUND");

  const t = await getTask(authed(`/api/tasks/${task.id}`, b), params(task.id));
  assert.equal(t.status, 404);
  assert.equal(await codeOf(t), "NOT_FOUND");
});

test("A3: a forbidden id and a nonexistent id are indistinguishable", async () => {
  const { b, task } = await twoAccountsWithData();
  const absent = "00000000-0000-4000-8000-000000000000";

  const forbidden = await getTask(authed(`/api/tasks/${task.id}`, b), params(task.id));
  const missing = await getTask(authed(`/api/tasks/${absent}`, b), params(absent));

  assert.equal(forbidden.status, missing.status);
  assert.deepEqual(await forbidden.json(), await missing.json(),
    "the two responses must be byte-identical, or the difference is an enumeration oracle");
});

test("AT-36: a cross-account mutation 404s and leaves the victim's row untouched", async () => {
  const { b, task } = await twoAccountsWithData();

  const patched = await patchTask(
    authed(`/api/tasks/${task.id}`, b, { method: "PATCH", body: JSON.stringify({ title: "pwned", deadline: "2030-01-01" }) }),
    params(task.id));
  assert.equal(patched.status, 404);
  assert.equal(await codeOf(patched), "NOT_FOUND");

  // Read back as the superuser: the assertion is about the stored row, not
  // about what the API chose to echo.
  const { rows } = await superPool.query<{ title: string; deadline: Date }>(
    "SELECT title, deadline FROM tasks WHERE id = $1", [task.id]);
  assert.equal(rows[0]?.title, "A's task", "the victim's title must be unchanged");
  assert.equal(rows[0]?.deadline?.toISOString().slice(0, 10), "2026-12-01");
});

test("AT-36: a cross-account delete 404s and deletes nothing", async () => {
  const { b, project, task } = await twoAccountsWithData();

  const dt = await deleteTask(authed(`/api/tasks/${task.id}`, b, { method: "DELETE" }), params(task.id));
  assert.equal(dt.status, 404);
  const dp = await deleteProject(authed(`/api/projects/${project.id}`, b, { method: "DELETE" }), params(project.id));
  assert.equal(dp.status, 404);

  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM tasks WHERE id = $1", [task.id]);
  assert.equal(rows[0]?.n, "1", "the victim's task must still exist");
  const { rows: pr } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM projects WHERE id = $1", [project.id]);
  assert.equal(pr[0]?.n, "1", "the victim's project must still exist");
});

test("AT-37: a cross-account rename 404s and does not rename", async () => {
  const { b, project } = await twoAccountsWithData();
  const res = await patchProject(
    authed(`/api/projects/${project.id}`, b, { method: "PATCH", body: JSON.stringify({ name: "mine now" }) }),
    params(project.id));
  assert.equal(res.status, 404);
  const { rows } = await superPool.query<{ name: string }>(
    "SELECT name FROM projects WHERE id = $1", [project.id]);
  assert.equal(rows[0]?.name, "A's project");
});

test("AT-37: B cannot LINK A's rows into B's own data", async () => {
  const { a, b, project, task } = await twoAccountsWithData();

  // Attaching B's new task to A's project.
  const intoProject = await createTask(authed("/api/tasks", b, {
    method: "POST", body: JSON.stringify({ title: "B's task", projectId: project.id }),
  }));
  assert.equal(intoProject.status, 404, "A's project id must not be attachable");
  assert.equal(await codeOf(intoProject), "NOT_FOUND");

  // Making A's task the parent of B's task.
  const asParent = await createTask(authed("/api/tasks", b, {
    method: "POST", body: JSON.stringify({ title: "B's subtask", parentTaskId: task.id }),
  }));
  assert.equal(asParent.status, 404, "A's task id must not be usable as a parent");

  // Depending on A's task from B's own task.
  const bTask = (await json(await createTask(authed("/api/tasks", b, {
    method: "POST", body: JSON.stringify({ title: "B's own" }),
  })))).task;
  const dep = await linkDependency(
    authed(`/api/tasks/${bTask.id}/dependencies`, b, { method: "POST", body: JSON.stringify({ dependsOnId: task.id }) }),
    params(bTask.id));
  assert.equal(dep.status, 404, "a dependency on another account's task must 404");

  // And the reverse direction: B pointing A's task at B's own.
  const reverse = await linkDependency(
    authed(`/api/tasks/${task.id}/dependencies`, b, { method: "POST", body: JSON.stringify({ dependsOnId: bTask.id }) }),
    params(task.id));
  assert.equal(reverse.status, 404);

  // No edge was created in either direction, for either owner.
  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM task_dependencies WHERE task_id = ANY($1::uuid[]) OR depends_on_id = ANY($1::uuid[])",
    [[task.id, bTask.id]]);
  assert.equal(rows[0]?.n, "0");

  // A's own data is still intact and still A's.
  const aTasks = (await json(await listTasks(authed("/api/tasks", a)))).tasks;
  assert.deepEqual(aTasks.map((t: any) => t.id), [task.id]);
});

test("AT-33: every route refuses an unauthenticated request with 401", async () => {
  const { project, task } = await twoAccountsWithData();
  const id = task.id;

  const calls: [string, Promise<Response>][] = [
    ["GET /api/projects", listProjects(anonymous("/api/projects"))],
    ["POST /api/projects", createProject(anonymous("/api/projects", { method: "POST", body: JSON.stringify({ name: "x" }) }))],
    ["GET /api/projects/:id", getProject(anonymous(`/api/projects/${project.id}`), params(project.id))],
    ["PATCH /api/projects/:id", patchProject(anonymous(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ name: "x" }) }), params(project.id))],
    ["DELETE /api/projects/:id", deleteProject(anonymous(`/api/projects/${project.id}`, { method: "DELETE" }), params(project.id))],
    ["GET /api/tasks", listTasks(anonymous("/api/tasks"))],
    ["POST /api/tasks", createTask(anonymous("/api/tasks", { method: "POST", body: JSON.stringify({ title: "x" }) }))],
    ["GET /api/tasks/:id", getTask(anonymous(`/api/tasks/${id}`), params(id))],
    ["PATCH /api/tasks/:id", patchTask(anonymous(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ title: "x" }) }), params(id))],
    ["DELETE /api/tasks/:id", deleteTask(anonymous(`/api/tasks/${id}`, { method: "DELETE" }), params(id))],
    ["POST /api/tasks/:id/dependencies", linkDependency(anonymous(`/api/tasks/${id}/dependencies`, { method: "POST", body: JSON.stringify({ dependsOnId: id }) }), params(id))],
    ["GET /api/me", getMe(anonymous("/api/me"))],
    ["PATCH /api/me", patchMe(anonymous("/api/me", { method: "PATCH", body: JSON.stringify({ timezone: "UTC" }) }))],
  ];

  for (const [name, p] of calls) {
    const res = await p;
    assert.equal(res.status, 401, `${name} must refuse an anonymous caller`);
    assert.equal(await codeOf(res), "UNAUTHENTICATED", `${name} envelope`);
  }

  // Nothing was written by any of those rejected calls.
  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM projects WHERE name = 'x'");
  assert.equal(rows[0]?.n, "0");
});

test("A3: there is no 403 anywhere in the API", async () => {
  // A3 is a property of the whole surface, not of one handler: a 403 would be
  // an enumeration oracle wherever it appeared. Every cross-account call this
  // suite makes is checked for one.
  const { b, project, task } = await twoAccountsWithData();
  const responses = await Promise.all([
    getProject(authed(`/api/projects/${project.id}`, b), params(project.id)),
    patchProject(authed(`/api/projects/${project.id}`, b, { method: "PATCH", body: JSON.stringify({ name: "n" }) }), params(project.id)),
    deleteProject(authed(`/api/projects/${project.id}`, b, { method: "DELETE" }), params(project.id)),
    getTask(authed(`/api/tasks/${task.id}`, b), params(task.id)),
    patchTask(authed(`/api/tasks/${task.id}`, b, { method: "PATCH", body: JSON.stringify({ title: "n" }) }), params(task.id)),
    deleteTask(authed(`/api/tasks/${task.id}`, b, { method: "DELETE" }), params(task.id)),
  ]);
  for (const res of responses) {
    assert.notEqual(res.status, 403, "A3 forbids 403; use 404");
    assert.equal(res.status, 404);
  }
});

test("A2: an expired session cannot act, even on the account's own data", async () => {
  const { a, task } = await twoAccountsWithData();
  const { expireSession } = await import("./auth-helpers.ts");
  await expireSession(a);
  const res = await getTask(authed(`/api/tasks/${task.id}`, a), params(task.id));
  assert.equal(res.status, 401, "expiry must be enforced on domain routes, not only on /api/auth");
  assert.equal(await codeOf(res), "UNAUTHENTICATED");
});

test("P5: /api/me reads and updates only the caller's own row", async () => {
  const [a, b] = await signUpTwo();

  const mine = await json(await getMe(authed("/api/me", a)));
  assert.equal(mine.user.id, a.userId);
  const theirs = await json(await getMe(authed("/api/me", b)));
  assert.equal(theirs.user.id, b.userId, "each session must resolve to its own user row");

  const ok = await patchMe(authed("/api/me", a, { method: "PATCH", body: JSON.stringify({ timezone: "Europe/Lisbon" }) }));
  assert.equal(ok.status, 200);

  // An unknown zone is refused by the database's own tz table (P5), surfaced
  // as 422 rather than a 500.
  const bad = await patchMe(authed("/api/me", a, { method: "PATCH", body: JSON.stringify({ timezone: "Mars/Olympus" }) }));
  assert.equal(bad.status, 422);
  assert.equal(await codeOf(bad), "VALIDATION_FAILED");

  // A's change did not touch B.
  const { rows } = await superPool.query<{ id: string; timezone: string }>(
    "SELECT id::text AS id, timezone FROM users WHERE id = ANY($1::uuid[])", [[a.userId, b.userId]]);
  const byId = new Map(rows.map((r) => [r.id, r.timezone]));
  assert.equal(byId.get(a.userId), "Europe/Lisbon");
  assert.equal(byId.get(b.userId), "UTC");
});
