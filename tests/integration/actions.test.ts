import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ headers: new Headers(), revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  // Better Auth's nextCookies() plugin mirrors Set-Cookie into next/headers; ignore it here.
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidatePath }));
// React's cache() is a no-op outside a server render; keep it transparent.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T>(fn: T) => fn }));

const { auth } = await import("@/server/auth");
const { createTaskAction, setTaskCompletedAction, updateTaskAction, deleteTaskAction } = await import(
  "@/server/actions/tasks"
);
const { createProjectAction } = await import("@/server/actions/projects");
const tasksRepo = await import("@/server/repo/tasks");
const { createUser, resetDb } = await import("./helpers");

/** Signs a user up and makes their session cookie the current request's. Returns their id. */
async function signIn(email: string): Promise<string> {
  const res = await auth.api.signUpEmail({
    body: { name: "Test User", email, password: "correct horse battery" },
    asResponse: true,
  });
  const cookie = res.headers.getSetCookie().find((c) => c.includes("better-auth.session_token="))!;
  state.headers = new Headers({ cookie: cookie.split(";")[0]! });
  const { user } = (await res.json()) as { user: { id: string } };
  return user.id;
}

beforeEach(async () => {
  await resetDb();
  state.headers = new Headers();
  state.revalidatePath.mockClear();
});

describe("task actions", () => {
  it("createTaskAction with only a title lands the task in the Inbox", async () => {
    const userId = await signIn("ada@example.com");

    const result = await createTaskAction({ title: "  Buy milk " });

    expect(result).toMatchObject({ ok: true, data: { title: "Buy milk", projectId: null, userId } });
    expect(state.revalidatePath).toHaveBeenCalled();
    const inbox = await tasksRepo.listInboxTasks(userId);
    expect(inbox.open.map((t) => t.title)).toEqual(["Buy milk"]);
  });

  it("returns field errors for invalid input without writing anything", async () => {
    const userId = await signIn("ada@example.com");

    const blank = await createTaskAction({ title: "   " });
    expect(blank).toEqual({
      ok: false,
      error: "Title is required",
      fieldErrors: { title: ["Title is required"] },
    });

    const task = await tasksRepo.createTask(userId, { title: "x" });
    const bad = await updateTaskAction({ id: task.id, estimateMin: 0, deadline: "2026-02-30" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toEqual(expect.any(String));
    expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual(["deadline", "estimateMin"]);

    expect(await createTaskAction({})).toMatchObject({ ok: false, fieldErrors: { title: expect.any(Array) } });
    expect(await updateTaskAction({ id: "nope" })).toMatchObject({ ok: false, fieldErrors: { id: expect.any(Array) } });

    expect((await tasksRepo.listInboxTasks(userId)).open).toHaveLength(1);
    expect(state.revalidatePath).not.toHaveBeenCalled();
  });

  it("updateTaskAction sets and then clears optional fields with null", async () => {
    await signIn("ada@example.com");
    const project = await createProjectAction({ name: "Home" });
    if (!project.ok) throw new Error(project.error);
    const created = await createTaskAction({ title: "Fix tap" });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;

    const set = await updateTaskAction({
      id,
      description: "Kitchen",
      priority: 1,
      deadline: "2026-11-05",
      estimateMin: 20,
      projectId: project.data.id,
    });
    expect(set).toMatchObject({
      ok: true,
      data: { description: "Kitchen", priority: 1, deadline: "2026-11-05", estimateMin: 20, projectId: project.data.id },
    });

    const cleared = await updateTaskAction({
      id,
      description: "   ",
      priority: null,
      deadline: null,
      estimateMin: null,
      projectId: null,
    });
    expect(cleared).toMatchObject({
      ok: true,
      data: { title: "Fix tap", description: null, priority: 4, deadline: null, estimateMin: null, projectId: null },
    });
  });

  it("complete then reopen clears completedAt", async () => {
    await signIn("ada@example.com");
    const created = await createTaskAction({ title: "x" });
    if (!created.ok) throw new Error(created.error);

    const done = await setTaskCompletedAction({ id: created.data.id, completed: true });
    expect(done).toMatchObject({ ok: true, data: { status: "done", completedAt: expect.any(Date) } });
    const reopened = await setTaskCompletedAction({ id: created.data.id, completed: false });
    expect(reopened).toMatchObject({ ok: true, data: { status: "open", completedAt: null } });
  });

  it("acting on another user's task returns Task not found and changes nothing", async () => {
    const other = await createUser("Mallory");
    const theirs = await tasksRepo.createTask(other, { title: "Not yours" });
    await signIn("ada@example.com");

    expect(await updateTaskAction({ id: theirs.id, title: "pwned" })).toEqual({ ok: false, error: "Task not found" });
    expect(await setTaskCompletedAction({ id: theirs.id, completed: true })).toEqual({
      ok: false,
      error: "Task not found",
    });
    expect(await deleteTaskAction({ id: theirs.id })).toEqual({ ok: false, error: "Task not found" });

    expect(await tasksRepo.getTask(other, theirs.id)).toMatchObject({ title: "Not yours", status: "open" });
  });

  it("redirects to /login without a session", async () => {
    await expect(createTaskAction({ title: "x" })).rejects.toThrow("REDIRECT:/login");
    await expect(createProjectAction({ name: "x" })).rejects.toThrow("REDIRECT:/login");
  });
});
