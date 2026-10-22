import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ./next-mocks.
vi.mock("next/headers", async () => (await import("./next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("./next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("./next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("./next-mocks")).reactCache }));

import { toTaskView } from "@/components/tasks/types";
import { wouldCreateCycle } from "@/core/graph";
import { addBlockerAction, removeBlockerAction, setTaskCompletedAction } from "@/server/actions/tasks";
import { db } from "@/server/db";
import { taskDependencies, type Task } from "@/server/db/schema";
import { addBlocker, removeBlocker } from "@/server/repo/dependencies";
import { DependencyCycleError } from "@/server/repo/errors";
import { createProject } from "@/server/repo/projects";
import { createTask, getTask, listInboxTasks, listOpenTaskTitles, listProjectTasks } from "@/server/repo/tasks";
import { createUser, resetDb } from "./helpers";
import { actAs, revalidatePath } from "./next-mocks";
import { signIn } from "./session-helpers";

let userId: string;

beforeEach(async () => {
  await resetDb();
  actAs(null);
  revalidatePath.mockClear();
});

const edgesOf = async (uid: string) =>
  (await db.select().from(taskDependencies).where(eq(taskDependencies.userId, uid)))
    .map((e) => `${e.taskId}<${e.blockedByTaskId}`)
    .sort();

/** The Inbox as the page renders it, keyed by title. */
async function inboxViews(uid: string) {
  const { open, done } = await listInboxTasks(uid);
  return new Map([...open, ...done].map((t) => [t.title, toTaskView(t)]));
}

describe("blocked-ness follows the blocker's status (never stored)", () => {
  let paint: Task;
  let buy: Task;

  beforeEach(async () => {
    userId = await signIn("ada@example.com");
    buy = await createTask(userId, { title: "Buy paint" });
    paint = await createTask(userId, { title: "Paint the room" });
    expect(await addBlockerAction({ taskId: paint.id, blockedByTaskId: buy.id })).toEqual({ ok: true, data: undefined });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("completing the blocker unblocks the task; reopening it blocks the task again", async () => {
    let views = await inboxViews(userId);
    expect(views.get("Paint the room")).toMatchObject({
      blocked: true,
      blockers: [{ id: buy.id, title: "Buy paint", open: true }],
    });
    expect(views.get("Buy paint")).toMatchObject({ blocked: false, blockers: [] });

    expect(await setTaskCompletedAction({ id: buy.id, completed: true })).toMatchObject({ ok: true });
    views = await inboxViews(userId);
    expect(views.get("Paint the room")).toMatchObject({
      blocked: false,
      blockers: [{ id: buy.id, title: "Buy paint", open: false }],
    });

    expect(await setTaskCompletedAction({ id: buy.id, completed: false })).toMatchObject({ ok: true });
    views = await inboxViews(userId);
    expect(views.get("Paint the room")).toMatchObject({ blocked: true });

    // Only status changed; the link itself was never rewritten.
    expect(await edgesOf(userId)).toEqual([`${paint.id}<${buy.id}`]);
  });

  it("is blocked while any one of several blockers is open", async () => {
    const tape = await createTask(userId, { title: "Tape the edges" });
    await addBlocker(userId, paint.id, tape.id);
    await setTaskCompletedAction({ id: buy.id, completed: true });

    const view = (await inboxViews(userId)).get("Paint the room")!;
    expect(view.blocked).toBe(true);
    expect(view.blockers.filter((b) => b.open).map((b) => b.title)).toEqual(["Tape the edges"]);

    await setTaskCompletedAction({ id: tape.id, completed: true });
    expect((await inboxViews(userId)).get("Paint the room")!.blocked).toBe(false);
  });

  it("blockers in other projects are loaded with the list, and a completed task can still be added", async () => {
    const project = await createProject(userId, { name: "Shop" });
    const order = await createTask(userId, { title: "Order brushes", projectId: project.id });
    const old = await createTask(userId, { title: "Old chore" });
    await setTaskCompletedAction({ id: old.id, completed: true });

    await addBlocker(userId, paint.id, order.id);
    await addBlocker(userId, paint.id, old.id);

    const listed = (await listInboxTasks(userId)).open.find((t) => t.id === paint.id)!;
    expect(listed.blockers.map((b) => [b.title, b.status])).toEqual([
      ["Buy paint", "open"],
      ["Order brushes", "open"],
      ["Old chore", "done"],
    ]);
    expect((await getTask(userId, paint.id))!.blockers).toEqual(listed.blockers);
    // The project list loads blockers for its tasks too (none here).
    expect((await listProjectTasks(userId, project.id)).open[0]!.blockers).toEqual([]);
  });

  it("the picker offers every open task of the user, in any project", async () => {
    const project = await createProject(userId, { name: "Shop" });
    await createTask(userId, { title: "Order brushes", projectId: project.id });
    await setTaskCompletedAction({ id: buy.id, completed: true });

    expect((await listOpenTaskTitles(userId)).map((t) => t.title).sort()).toEqual(["Order brushes", "Paint the room"]);
  });
});

describe("loops are refused with a message and save nothing", () => {
  let a: Task;
  let b: Task;
  let c: Task;

  beforeEach(async () => {
    userId = await signIn("ada@example.com");
    a = await createTask(userId, { title: "A" });
    b = await createTask(userId, { title: "B" });
    c = await createTask(userId, { title: "C" });
  });

  async function expectRefused(taskId: string, blockedByTaskId: string, error: string) {
    const before = await edgesOf(userId);
    revalidatePath.mockClear();
    expect(await addBlockerAction({ taskId, blockedByTaskId })).toEqual({ ok: false, error });
    expect(await edgesOf(userId)).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  }

  it("self", async () => {
    await expectRefused(a.id, a.id, 'That would create a loop: "A" would wait on itself.');
  });

  it("2-cycle", async () => {
    await addBlocker(userId, a.id, b.id);
    await expectRefused(b.id, a.id, 'That would create a loop: "B" waits on "A", which waits on "B".');
  });

  it("longer loop", async () => {
    await addBlocker(userId, a.id, b.id);
    await addBlocker(userId, b.id, c.id);
    await expectRefused(c.id, a.id, 'That would create a loop: "C" waits on "A", which waits on "B", which waits on "C".');
  });

  it("a loop through a completed task is still a loop", async () => {
    await addBlocker(userId, a.id, b.id);
    await setTaskCompletedAction({ id: b.id, completed: true });
    await expectRefused(b.id, a.id, 'That would create a loop: "B" waits on "A", which waits on "B".');
  });

  it("the repo throws DependencyCycleError", async () => {
    await addBlocker(userId, a.id, b.id);
    await expect(addBlocker(userId, b.id, a.id)).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("links that don't close a loop are fine, including shortcuts", async () => {
    await addBlocker(userId, a.id, b.id);
    await addBlocker(userId, b.id, c.id);
    expect(await addBlockerAction({ taskId: a.id, blockedByTaskId: c.id })).toMatchObject({ ok: true });
    expect(await edgesOf(userId)).toEqual([`${a.id}<${b.id}`, `${a.id}<${c.id}`, `${b.id}<${c.id}`].sort());
  });
});

describe("adding and removing links", () => {
  beforeEach(async () => {
    userId = await signIn("ada@example.com");
  });

  it("adding an existing link is a no-op; removing one that isn't there is too", async () => {
    const a = await createTask(userId, { title: "A" });
    const b = await createTask(userId, { title: "B" });

    expect(await addBlockerAction({ taskId: a.id, blockedByTaskId: b.id })).toMatchObject({ ok: true });
    const [first] = await db.select().from(taskDependencies);
    expect(await addBlockerAction({ taskId: a.id, blockedByTaskId: b.id })).toMatchObject({ ok: true });
    expect(await db.select().from(taskDependencies)).toEqual([first]);

    expect(await removeBlockerAction({ taskId: a.id, blockedByTaskId: b.id })).toEqual({ ok: true, data: undefined });
    expect(await edgesOf(userId)).toEqual([]);
    expect(await removeBlockerAction({ taskId: a.id, blockedByTaskId: b.id })).toEqual({ ok: true, data: undefined });
    // The reverse direction was never a link; removing it doesn't touch anything else.
    await addBlocker(userId, a.id, b.id);
    await removeBlocker(userId, b.id, a.id);
    expect(await edgesOf(userId)).toEqual([`${a.id}<${b.id}`]);
  });

  it("unknown ids are not found and invalid ids are field errors; nothing is written", async () => {
    const a = await createTask(userId, { title: "A" });
    const missing = "00000000-0000-4000-8000-000000000000";

    expect(await addBlockerAction({ taskId: a.id, blockedByTaskId: missing })).toEqual({
      ok: false,
      error: "Task not found",
    });
    expect(await removeBlockerAction({ taskId: missing, blockedByTaskId: a.id })).toEqual({
      ok: false,
      error: "Task not found",
    });
    expect(await addBlockerAction({ taskId: a.id, blockedByTaskId: "nope" })).toMatchObject({
      ok: false,
      fieldErrors: { blockedByTaskId: expect.any(Array) },
    });
    expect(await addBlockerAction({ taskId: a.id })).toMatchObject({ ok: false });
    expect(await edgesOf(userId)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    actAs(null);
    await expect(addBlockerAction({})).rejects.toThrow("REDIRECT:/login");
    await expect(removeBlockerAction({})).rejects.toThrow("REDIRECT:/login");
  });
});

describe("the cycle check holds under concurrency", () => {
  beforeEach(async () => {
    userId = await createUser("Ada");
  });

  it("of two concurrent adds that together close a 2-cycle, exactly one wins", async () => {
    for (let round = 0; round < 10; round++) {
      const a = await createTask(userId, { title: `A${round}` });
      const b = await createTask(userId, { title: `B${round}` });
      const results = await Promise.allSettled([addBlocker(userId, a.id, b.id), addBlocker(userId, b.id, a.id)]);

      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(DependencyCycleError);
    }
    await expectAcyclic(userId);
  });

  it("of three concurrent adds that together close a 3-cycle, at most two win", async () => {
    for (let round = 0; round < 10; round++) {
      const [a, b, c] = await Promise.all(["A", "B", "C"].map((t) => createTask(userId, { title: `${t}${round}` })));
      const results = await Promise.allSettled([
        addBlocker(userId, a!.id, b!.id),
        addBlocker(userId, b!.id, c!.id),
        addBlocker(userId, c!.id, a!.id),
      ]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(2);
    }
    await expectAcyclic(userId);
  });

  it("a different user's adds are not held up or affected", async () => {
    const other = await createUser("Bob");
    const [a, b] = await Promise.all([createTask(userId, { title: "A" }), createTask(userId, { title: "B" })]);
    const [x, y] = await Promise.all([createTask(other, { title: "X" }), createTask(other, { title: "Y" })]);
    const results = await Promise.allSettled([
      addBlocker(userId, a.id, b.id),
      addBlocker(other, x.id, y.id),
      addBlocker(other, y.id, x.id),
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results.slice(1).filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await edgesOf(userId)).toEqual([`${a.id}<${b.id}`]);
  });
});

/** No edge of the user's graph is part of a loop. */
async function expectAcyclic(uid: string) {
  const edges = (await db.select().from(taskDependencies).where(eq(taskDependencies.userId, uid))).map((e) => ({
    taskId: e.taskId,
    blockedById: e.blockedByTaskId,
  }));
  for (const [i, e] of edges.entries()) {
    const rest = edges.filter((_, j) => j !== i);
    expect(wouldCreateCycle(rest, e.taskId, e.blockedById), `${e.taskId} < ${e.blockedById} is in a loop`).toBe(false);
  }
}
