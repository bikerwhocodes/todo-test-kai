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
import { anonymous, authed, codeOf, params, signUp, signUpTwo } from "./auth-helpers.ts";

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
  // `deadline::text` rather than reading the Date and calling toISOString():
  // pg parses a `date` into LOCAL midnight, so toISOString() shifts the day in
  // any timezone east of UTC. This assertion previously failed under
  // TZ=Pacific/Auckland for that reason — the test carried the same defect as
  // the code it was checking. Casting in SQL sidesteps the Date entirely.
  const { rows } = await superPool.query<{ title: string; deadline: string }>(
    "SELECT title, deadline::text AS deadline FROM tasks WHERE id = $1", [task.id]);
  assert.equal(rows[0]?.title, "A's task", "the victim's title must be unchanged");
  assert.equal(rows[0]?.deadline, "2026-12-01");
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

test("A9: hostile-origin unsafe methods cannot mutate stored data", async () => {
  const account = await signUp();
  const victimCreate = await createProject(authed("/api/projects", account, {
    method: "POST", body: JSON.stringify({ name: "Victim" }),
  }));
  const victim = (await json(victimCreate)).project;
  const controlCreate = await createProject(authed("/api/projects", account, {
    method: "POST", body: JSON.stringify({ name: "Control" }),
  }));
  const control = (await json(controlCreate)).project;
  const controlPatch = await patchProject(
    authed(`/api/projects/${control.id}`, account, {
      method: "PATCH", body: JSON.stringify({ name: "Control updated" }),
    }),
    params(control.id),
  );
  const controlDelete = await deleteProject(
    authed(`/api/projects/${control.id}`, account, { method: "DELETE" }),
    params(control.id),
  );

  const hostileOrigin = "https://evil.example.test";
  const hostilePost = await createProject(authed("/api/projects", account, {
    method: "POST",
    headers: { origin: hostileOrigin, "content-type": "text/plain" },
    body: JSON.stringify({ name: "Forged" }),
  }));
  const hostilePatch = await patchProject(
    authed(`/api/projects/${victim.id}`, account, {
      method: "PATCH",
      headers: { origin: hostileOrigin, "content-type": "text/plain" },
      body: JSON.stringify({ name: "Pwned" }),
    }),
    params(victim.id),
  );
  const hostileDelete = await deleteProject(
    authed(`/api/projects/${victim.id}`, account, {
      method: "DELETE", headers: { origin: hostileOrigin },
    }),
    params(victim.id),
  );

  const { rows: [state] } = await superPool.query<{
    forged_count: number;
    victim_count: number;
    victim_name: string | null;
    control_count: number;
  }>(`SELECT
        (SELECT count(*)::int FROM projects WHERE user_id = $1 AND name = 'Forged') AS forged_count,
        (SELECT count(*)::int FROM projects WHERE id = $2) AS victim_count,
        (SELECT name FROM projects WHERE id = $2) AS victim_name,
        (SELECT count(*)::int FROM projects WHERE id = $3) AS control_count`,
    [account.userId, victim.id, control.id]);

  assert.deepEqual({
    trusted: [victimCreate.status, controlCreate.status, controlPatch.status, controlDelete.status],
    hostile: [hostilePost.status, hostilePatch.status, hostileDelete.status],
    state,
  }, {
    trusted: [201, 201, 200, 204],
    hostile: [403, 403, 403],
    state: { forged_count: 0, victim_count: 1, victim_name: "Victim", control_count: 0 },
  });
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

test("a malformed path id returns 404, never 500 — and never reveals it was malformed", async () => {
  // Regression: a non-UUID path segment reached Postgres, raised
  // `22P02 invalid input syntax for type uuid`, and surfaced as 500 INTERNAL
  // on eight endpoints. A 500 for user input reports a server fault for a
  // client mistake and buries real faults in log noise.
  //
  // The answer must be the SAME 404 a nonexistent id gets: a 422 would leak
  // that an id was well-formed, which is the enumeration oracle in miniature.
  const [a] = await signUpTwo();
  const absent = "00000000-0000-4000-8000-000000000000";
  const reference = await getTask(authed(`/api/tasks/${absent}`, a), params(absent));
  const expected = await reference.json();

  for (const bad of ["abc", "not-a-uuid", "1", "%20", "", "../../etc/passwd",
                     "00000000-0000-4000-8000-00000000000"]) {
    const calls: [string, Promise<Response>][] = [
      [`GET /api/tasks/${bad}`, getTask(authed(`/api/tasks/${bad}`, a), params(bad))],
      [`PATCH /api/tasks/${bad}`, patchTask(authed(`/api/tasks/${bad}`, a, { method: "PATCH", body: JSON.stringify({ title: "x" }) }), params(bad))],
      [`DELETE /api/tasks/${bad}`, deleteTask(authed(`/api/tasks/${bad}`, a, { method: "DELETE" }), params(bad))],
      [`GET /api/projects/${bad}`, getProject(authed(`/api/projects/${bad}`, a), params(bad))],
      [`PATCH /api/projects/${bad}`, patchProject(authed(`/api/projects/${bad}`, a, { method: "PATCH", body: JSON.stringify({ name: "x" }) }), params(bad))],
      [`DELETE /api/projects/${bad}`, deleteProject(authed(`/api/projects/${bad}`, a, { method: "DELETE" }), params(bad))],
      [`POST /api/tasks/${bad}/dependencies`, linkDependency(authed(`/api/tasks/${bad}/dependencies`, a, { method: "POST", body: JSON.stringify({ dependsOnId: absent }) }), params(bad))],
    ];
    for (const [name, p] of calls) {
      const res = await p;
      assert.equal(res.status, 404, `${name} must be 404, not ${res.status}`);
      if (res.status === 404) {
        assert.deepEqual(await res.json(), expected,
          `${name} must be byte-identical to a nonexistent id's response`);
      }
    }
  }
});

test("a malformed id in a request BODY also returns 404, like a foreign one", async () => {
  const [a] = await signUpTwo();
  const mine = (await json(await createTask(
    authed("/api/tasks", a, { method: "POST", body: JSON.stringify({ title: "mine" }) }),
  ))).task;

  for (const body of [{ title: "x", projectId: "abc" }, { title: "x", parentTaskId: "abc" }]) {
    const res = await createTask(authed("/api/tasks", a, { method: "POST", body: JSON.stringify(body) }));
    assert.equal(res.status, 404, `POST with ${JSON.stringify(body)} must be 404, not ${res.status}`);
  }
  const patched = await patchTask(
    authed(`/api/tasks/${mine.id}`, a, { method: "PATCH", body: JSON.stringify({ projectId: "abc" }) }),
    params(mine.id));
  assert.equal(patched.status, 404, "PATCH with a malformed projectId must be 404");

  // The task was not half-written by any rejected call.
  const after = (await json(await listTasks(authed("/api/tasks", a)))).tasks;
  assert.deepEqual(after.map((t: any) => t.id), [mine.id]);
});

test("P4: a calendar date round-trips through the API as the SAME day", async () => {
  // The defect this pins: pg parses a `date` into LOCAL midnight, and
  // `toISOString()` re-reads that instant in UTC, moving the day BACKWARDS
  // for every timezone east of UTC. Reproduced against the real database:
  // a deadline stored as 2026-12-01 was reported as 2026-11-30 under
  // TZ=Pacific/Auckland and TZ=Europe/Berlin, while TZ=UTC looked fine.
  //
  // This assertion is timezone-independent — it compares what the API returns
  // against what Postgres actually stores — so it holds everywhere and fails
  // everywhere east of UTC without the fix. `npm run test:tz` runs the whole
  // suite under an eastern zone, which is what makes the class catchable at all.
  const [a] = await signUpTwo();
  const DEADLINE = "2026-12-01";
  const START = "2026-11-20";

  const created = (await json(await createTask(authed("/api/tasks", a, {
    method: "POST",
    body: JSON.stringify({ title: "dated", deadline: DEADLINE, startDate: START }),
  })))).task;

  const { rows } = await superPool.query<{ deadline: string; start_date: string }>(
    "SELECT deadline::text AS deadline, start_date::text AS start_date FROM tasks WHERE id = $1",
    [created.id]);
  assert.equal(rows[0]?.deadline, DEADLINE, "Postgres must store the day it was sent");
  assert.equal(rows[0]?.start_date, START);

  // Every read path must agree with storage, not just the create response.
  assert.equal(created.deadline, rows[0]?.deadline, "POST response disagrees with storage");
  assert.equal(created.startDate, rows[0]?.start_date);

  const fetched = (await json(await getTask(authed(`/api/tasks/${created.id}`, a), params(created.id)))).task;
  assert.equal(fetched.deadline, DEADLINE, "GET /:id disagrees with storage");
  assert.equal(fetched.startDate, START);

  const listed = (await json(await listTasks(authed("/api/tasks", a)))).tasks
    .find((t: any) => t.id === created.id);
  assert.equal(listed.deadline, DEADLINE, "list disagrees with storage");
  assert.equal(listed.startDate, START);

  // And a calendar date is never serialised as an instant (P4).
  assert.match(fetched.deadline, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!String(fetched.deadline).includes("T"), "a calendar date must not carry a time");
});
