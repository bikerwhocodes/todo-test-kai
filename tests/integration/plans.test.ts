import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ./next-mocks.
vi.mock("next/headers", async () => (await import("./next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("./next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("./next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("./next-mocks")).reactCache }));

import { asc, eq } from "drizzle-orm";
import TodayPage from "@/app/(app)/today/page";
import { TaskGroup, type GroupItem } from "@/components/tasks/task-group";
import { PlanSection } from "@/components/today/plan-section";
import { db } from "@/server/db";
import { dayPlans, planDismissals, planItems, tasks } from "@/server/db/schema";
import {
  acceptPlanAction,
  addPlanItemAction,
  dismissSuggestionAction,
  removePlanItemAction,
  reorderPlanAction,
  suggestPlanAction,
} from "@/server/actions/plans";
import type { ActionResult } from "@/server/actions/result";
import { deleteTaskAction } from "@/server/actions/tasks";
import { addBlocker } from "@/server/repo/dependencies";
import { acceptSuggestions, getPlan, loadPlanInput } from "@/server/repo/plans";
import { createTask, setTaskCompleted, updateTask } from "@/server/repo/tasks";
import { updateUserSettings } from "@/server/repo/user-settings";
import type { TaskPatch } from "@/lib/validation";
import { CHECK_VIOLATION, FK_VIOLATION, UNIQUE_VIOLATION, expectPgError, resetDb } from "./helpers";
import { snapshotOf } from "./isolation/world";
import { actAs, revalidatePath } from "./next-mocks";
import { signUp } from "./session-helpers";

// Plan My Day (spec §4): suggest saves nothing, accept/edits write only the plan
// tables, and "today" is the user's local date.

const LA = "America/Los_Angeles";
const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14
// 13:00 on 10-22 in Los Angeles (PDT), 10:00 on 10-23 in Kiritimati.
const NOW = new Date("2026-10-22T20:00:00Z");
const TODAY = "2026-10-22"; // in LA at NOW

let userId: string;
let cookie: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  revalidatePath.mockClear();
  const user = await signUp("ada@example.com", { timeZone: LA });
  actAs(user.cookie);
  userId = user.id;
  cookie = user.cookie;
});

afterEach(() => {
  vi.useRealTimers();
});

function data<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`action failed: ${result.error}`);
  return result.data;
}

async function task(title: string, patch: TaskPatch = {}, owner = userId) {
  const created = await createTask(owner, { title });
  return Object.keys(patch).length > 0 ? updateTask(owner, created.id, patch) : created;
}

/** Every task row the user owns, whole. */
const taskRows = () => db.select().from(tasks).where(eq(tasks.userId, userId)).orderBy(asc(tasks.id));

const planTitles = async (date = TODAY) => (await getPlan(userId, date)).items.map((i) => i.task.title);

const titlesOf = (list: { title: string }[]) => list.map((s) => s.title);

/** Tables whose rows differ between two snapshots. */
function changedTables(before: Record<string, string[]>, after: Record<string, string[]>) {
  return Object.keys({ ...before, ...after })
    .filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after[t]))
    .sort();
}

/** A typical backlog: overdue, due today, no deadline, too big, and done. */
async function backlog() {
  return {
    overdue: await task("Overdue", { deadline: "2026-10-20", estimateMin: 30, priority: 2 }),
    dueToday: await task("Due today", { deadline: TODAY, estimateMin: 60 }),
    someday: await task("Someday", { estimateMin: 15 }),
    huge: await task("Huge", { estimateMin: 600 }),
    done: await setTaskCompleted(userId, (await task("Done", { estimateMin: 5 })).id, true, TODAY),
  };
}

describe("suggestPlanAction", () => {
  it("writes nothing (AC1) and leaves every task row as it was (AC3)", async () => {
    const t = await backlog();
    // A previous plan and a dismissal, so every plan table has rows to compare.
    await acceptSuggestions(userId, "2026-10-21", { taskIds: [t.someday.id], availableMin: 60 });
    data(await dismissSuggestionAction({ taskId: t.huge.id }));
    revalidatePath.mockClear();
    const before = await snapshotOf(userId, { except: ["sessions"] });
    const rowsBefore = await taskRows();

    const draft = data(await suggestPlanAction({ availableMin: 120 }));

    expect(await snapshotOf(userId, { except: ["sessions"] })).toEqual(before);
    expect(await taskRows()).toEqual(rowsBefore);
    expect(revalidatePath).not.toHaveBeenCalled();
    // 30 + 60 + 15 fit in 120; Huge was dismissed today; Done is never suggested.
    expect(titlesOf(draft.suggestions)).toEqual(["Overdue", "Due today", "Someday"]);
    expect(draft.suggestions[2]!.reasons.map((r) => r.code)).toContain("CARRIED_OVER");
    expect(draft.totals).toMatchObject({ availableMin: 120, suggestedMin: 105, remainingMin: 15 });
    expect(draft.excluded).toEqual(
      expect.arrayContaining([
        { id: t.huge.id, reason: "dismissed" },
        { id: t.done.id, reason: "done" },
      ]),
    );
  });

  it("lists what didn't fit, with titles", async () => {
    await backlog();
    const draft = data(await suggestPlanAction({ availableMin: 100 }));
    expect(titlesOf(draft.suggestions)).toEqual(["Overdue", "Due today"]);
    // Someday (rank 3) would fit on its own; Huge needs more than the whole 100 minutes.
    expect(draft.didntFit.map((d) => [d.title, d.size.code])).toEqual([
      ["Someday", "NO_ROOM_LEFT"],
      ["Huge", "TOO_LARGE"],
    ]);
    expect(draft.didntFit[1]).toMatchObject({ projectId: null, rank: 4 });
  });

  it("never suggests a blocked task, and counts the user's default estimate", async () => {
    await updateUserSettings(userId, { defaultEstimateMin: 45 });
    const blocker = await task("Blocker", { estimateMin: 10 });
    const blocked = await task("Blocked", { deadline: TODAY, priority: 1, estimateMin: 10 });
    const unsized = await task("Unsized");
    await addBlocker(userId, blocked.id, blocker.id);

    const draft = data(await suggestPlanAction({ availableMin: 600 }));
    expect(titlesOf(draft.suggestions)).toEqual(["Blocker", "Unsized"]);
    expect(draft.suggestions[0]!.reasons.map((r) => r.code)).toContain("UNBLOCKS");
    expect(draft.suggestions.find((s) => s.task.id === unsized.id)!.estimateMin).toBe(45);
    expect(draft.excluded).toContainEqual({ id: blocked.id, reason: "blocked" });

    await setTaskCompleted(userId, blocker.id, true, TODAY);
    expect(titlesOf(data(await suggestPlanAction({ availableMin: 600 })).suggestions)).toEqual(["Blocked", "Unsized"]);
  });

  it("requires a signed-in user", async () => {
    actAs(null);
    await expect(suggestPlanAction({ availableMin: 60 })).rejects.toThrow("REDIRECT:/login");
    await expect(acceptPlanAction({ taskIds: [] })).rejects.toThrow("REDIRECT:/login");
  });

  it("rejects invalid available time", async () => {
    for (const availableMin of [-1, 1.5, 1441, "60", undefined]) {
      expect(await suggestPlanAction({ availableMin })).toMatchObject({ ok: false });
    }
  });
});

describe("loadPlanInput", () => {
  it("carries over the open tasks of the latest earlier plan only", async () => {
    const older = await task("From two days ago");
    const left = await task("Left over");
    const finished = await task("Finished yesterday");
    await acceptSuggestions(userId, "2026-10-20", { taskIds: [older.id] });
    await acceptSuggestions(userId, "2026-10-21", { taskIds: [left.id, finished.id] });
    await setTaskCompleted(userId, finished.id, true, "2026-10-21");

    const input = await loadPlanInput(userId, TODAY);
    expect(input.carriedOverIds).toEqual([left.id]);
    expect(input.inPlanIds).toEqual([]);
    expect(input.today).toBe(TODAY);
  });

  it("includes today's planned tasks whatever their status, plus every open task and edge", async () => {
    const planned = await task("Planned then done", { estimateMin: 50 });
    const open = await task("Open");
    const blocker = await task("Blocker");
    const doneElsewhere = await setTaskCompleted(userId, (await task("Done, not planned")).id, true, TODAY);
    await addBlocker(userId, open.id, blocker.id);
    await acceptSuggestions(userId, TODAY, { taskIds: [planned.id] });
    await setTaskCompleted(userId, planned.id, true, TODAY);

    const input = await loadPlanInput(userId, TODAY);
    expect(input.tasks.map((t) => t.id).sort()).toEqual([planned.id, open.id, blocker.id].sort());
    expect(input.tasks.map((t) => t.id)).not.toContain(doneElsewhere.id);
    expect(input.edges).toEqual([{ taskId: open.id, blockedById: blocker.id }]);
    expect(input.inPlanIds).toEqual([planned.id]);

    // A done planned task doesn't use up any of the time.
    const draft = data(await suggestPlanAction({ availableMin: 60 }));
    expect(draft.totals).toMatchObject({ existingMin: 0, existingCount: 0 });
  });
});

describe("acceptPlanAction", () => {
  it("writes only day_plans and plan_items (AC2) and no task row changes (AC3)", async () => {
    const t = await backlog();
    const before = await snapshotOf(userId, { except: ["sessions"] });
    const rowsBefore = await taskRows();

    const added = data(await acceptPlanAction({ taskIds: [t.overdue.id, t.dueToday.id], availableMin: 120 }));

    expect(added).toEqual([t.overdue.id, t.dueToday.id]);
    expect(changedTables(before, await snapshotOf(userId, { except: ["sessions"] }))).toEqual(["day_plans", "plan_items"]);
    expect(await taskRows()).toEqual(rowsBefore);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    const plan = await getPlan(userId, TODAY);
    expect(plan.availableMin).toBe(120);
    expect(plan.items.map((i) => [i.task.title, i.position, i.source])).toEqual([
      ["Overdue", 0, "suggested"],
      ["Due today", 1, "suggested"],
    ]);
  });

  it("a second accept the same day keeps the existing order and appends (AC4)", async () => {
    const [one, two, three, four] = [await task("One"), await task("Two"), await task("Three"), await task("Four")];
    data(await acceptPlanAction({ taskIds: [two.id, one.id], availableMin: 60 }));
    data(await addPlanItemAction({ taskId: four.id }));
    const rowsBefore = await taskRows();

    // one is already planned and three is sent twice: only three is added, once, at the end.
    const added = data(await acceptPlanAction({ taskIds: [three.id, one.id, three.id] }));

    expect(added).toEqual([three.id]);
    expect(await planTitles()).toEqual(["Two", "One", "Four", "Three"]);
    expect((await getPlan(userId, TODAY)).items.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    // available_min is kept when not sent.
    expect((await getPlan(userId, TODAY)).availableMin).toBe(60);
    expect(await taskRows()).toEqual(rowsBefore);
    expect(await db.select().from(dayPlans).where(eq(dayPlans.userId, userId))).toHaveLength(1);
  });

  it("refuses a task that isn't open, saving nothing", async () => {
    const open = await task("Open");
    const done = await setTaskCompleted(userId, (await task("Done")).id, true, TODAY);
    const before = await snapshotOf(userId, { except: ["sessions"] });

    expect(await acceptPlanAction({ taskIds: [open.id, done.id], availableMin: 30 })).toEqual({
      ok: false,
      error: "Only open tasks can be added to the plan",
    });
    expect(await snapshotOf(userId, { except: ["sessions"] })).toEqual(before);
  });

  it("refuses ids that aren't the user's tasks, saving nothing", async () => {
    const open = await task("Open");
    const before = await snapshotOf(userId, { except: ["sessions"] });
    expect(
      await acceptPlanAction({ taskIds: [open.id, "00000000-0000-4000-8000-000000000000"] }),
    ).toEqual({ ok: false, error: "Task not found" });
    expect(await snapshotOf(userId, { except: ["sessions"] })).toEqual(before);
  });

  it("concurrent accepts don't interleave positions", async () => {
    const ts = await Promise.all(["a", "b", "c", "d", "e", "f"].map((x) => task(x)));
    await Promise.all([
      acceptSuggestions(userId, TODAY, { taskIds: ts.slice(0, 3).map((t) => t.id) }),
      acceptSuggestions(userId, TODAY, { taskIds: ts.slice(3).map((t) => t.id) }),
    ]);
    const titles = await planTitles();
    expect([titles.slice(0, 3), titles.slice(3)].map((g) => g.join(""))).toEqual(
      expect.arrayContaining(["abc", "def"]),
    );
    expect((await getPlan(userId, TODAY)).items.map((i) => i.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("plan edits are saved one at a time", () => {
  it("add, reorder and remove persist, and never change the task", async () => {
    const [one, two, three] = [await task("One"), await task("Two"), await task("Three", { deadline: TODAY })];
    data(await acceptPlanAction({ taskIds: [one.id, two.id] }));
    const rowsBefore = await taskRows();

    data(await addPlanItemAction({ taskId: three.id }));
    data(await addPlanItemAction({ taskId: three.id })); // already there: no-op
    expect((await getPlan(userId, TODAY)).items.map((i) => [i.task.title, i.source])).toEqual([
      ["One", "suggested"],
      ["Two", "suggested"],
      ["Three", "manual"],
    ]);

    data(await reorderPlanAction({ taskIds: [three.id, one.id, two.id] }));
    expect(await planTitles()).toEqual(["Three", "One", "Two"]);

    data(await removePlanItemAction({ taskId: one.id }));
    expect(await planTitles()).toEqual(["Three", "Two"]);
    expect(await removePlanItemAction({ taskId: one.id })).toEqual({ ok: false, error: "Task not found" });

    // Positions keep the order after a gap; the next add goes last.
    data(await addPlanItemAction({ taskId: one.id }));
    expect(await planTitles()).toEqual(["Three", "Two", "One"]);
    data(await reorderPlanAction({ taskIds: [one.id, two.id, three.id] }));
    expect((await getPlan(userId, TODAY)).items.map((i) => [i.task.title, i.position])).toEqual([
      ["One", 0],
      ["Two", 1],
      ["Three", 2],
    ]);

    expect(await taskRows()).toEqual(rowsBefore);
  });

  it("reorder must list exactly the planned tasks", async () => {
    const [one, two, other] = [await task("One"), await task("Two"), await task("Not planned")];
    data(await acceptPlanAction({ taskIds: [one.id, two.id] }));
    const before = await snapshotOf(userId, { except: ["sessions"] });

    for (const taskIds of [[one.id], [two.id, one.id, other.id], [two.id, two.id], [two.id, one.id, one.id], []]) {
      expect(await reorderPlanAction({ taskIds }), JSON.stringify(taskIds)).toEqual({
        ok: false,
        error: "Your plan has changed. Reload the page and try again.",
      });
    }
    expect(await snapshotOf(userId, { except: ["sessions"] })).toEqual(before);
    expect(await planTitles()).toEqual(["One", "Two"]);
  });

  it("removing from a day with no plan is not-found; reordering an empty plan is a no-op", async () => {
    const one = await task("One");
    expect(await removePlanItemAction({ taskId: one.id })).toEqual({ ok: false, error: "Task not found" });
    expect(await reorderPlanAction({ taskIds: [] })).toEqual({ ok: true, data: undefined });
    expect(await db.select().from(dayPlans).where(eq(dayPlans.userId, userId))).toEqual([]);
  });

  it("adding by hand refuses a task that isn't open and undoes today's dismissal", async () => {
    const done = await setTaskCompleted(userId, (await task("Done")).id, true, TODAY);
    const later = await task("Later");
    expect(await addPlanItemAction({ taskId: done.id })).toEqual({
      ok: false,
      error: "Only open tasks can be added to the plan",
    });

    data(await dismissSuggestionAction({ taskId: later.id }));
    data(await dismissSuggestionAction({ taskId: later.id })); // again: no-op
    expect(await db.select().from(planDismissals).where(eq(planDismissals.userId, userId))).toHaveLength(1);
    data(await addPlanItemAction({ taskId: later.id }));
    expect(await db.select().from(planDismissals).where(eq(planDismissals.userId, userId))).toEqual([]);
    expect(await planTitles()).toEqual(["Later"]);
  });

  it("deleting a task deletes its plan items and dismissals", async () => {
    const [one, two] = [await task("One"), await task("Two")];
    data(await acceptPlanAction({ taskIds: [one.id, two.id] }));
    data(await dismissSuggestionAction({ taskId: one.id }));

    data(await deleteTaskAction({ id: one.id }));

    expect(await planTitles()).toEqual(["Two"]);
    expect(await db.select().from(planItems).where(eq(planItems.taskId, one.id))).toEqual([]);
    expect(await db.select().from(planDismissals).where(eq(planDismissals.taskId, one.id))).toEqual([]);
  });

  it("completing a planned task keeps it in the plan", async () => {
    const one = await task("One");
    data(await acceptPlanAction({ taskIds: [one.id] }));
    await setTaskCompleted(userId, one.id, true, TODAY);
    expect((await getPlan(userId, TODAY)).items.map((i) => [i.task.title, i.task.status])).toEqual([["One", "done"]]);
  });
});

describe("the user's local date", () => {
  it("keys plans and dismissals by each user's own today, so a dismissal ends with the local day", async () => {
    const kiri = await signUp("kiri@example.com", { timeZone: KIRITIMATI });
    const laTask = await task("LA task", { estimateMin: 10 });
    const kiriTask = await task("Kiritimati task", { estimateMin: 10 }, kiri.id);

    // At NOW it is 10-22 in LA and 10-23 in Kiritimati.
    data(await dismissSuggestionAction({ taskId: laTask.id }));
    data(await acceptPlanAction({ taskIds: [], availableMin: 30 }));
    expect(data(await suggestPlanAction({ availableMin: 60 })).suggestions).toEqual([]);
    actAs(kiri.cookie);
    data(await dismissSuggestionAction({ taskId: kiriTask.id }));
    data(await acceptPlanAction({ taskIds: [], availableMin: 30 }));
    expect(data(await suggestPlanAction({ availableMin: 60 })).suggestions).toEqual([]);

    const dismissals = await db.select().from(planDismissals).orderBy(asc(planDismissals.planDate));
    expect(dismissals.map((d) => [d.userId, d.planDate, d.taskId])).toEqual([
      [userId, "2026-10-22", laTask.id],
      [kiri.id, "2026-10-23", kiriTask.id],
    ]);
    const plans = await db.select().from(dayPlans).orderBy(asc(dayPlans.planDate));
    expect(plans.map((p) => [p.userId, p.planDate])).toEqual([
      [userId, "2026-10-22"],
      [kiri.id, "2026-10-23"],
    ]);

    // 8 hours later: 01:00 on 10-23 in LA (a new day), 18:00 on 10-23 in Kiritimati (same day).
    vi.setSystemTime(new Date("2026-10-23T04:00:00Z"));
    expect(data(await suggestPlanAction({ availableMin: 60 })).suggestions).toEqual([]);
    actAs(cookie);
    expect(titlesOf(data(await suggestPlanAction({ availableMin: 60 })).suggestions)).toEqual(["LA task"]);
    // Yesterday's plan isn't today's either.
    expect((await getPlan(userId, "2026-10-23")).items).toEqual([]);
  });
});

describe("Today page", () => {
  type Element = { type: unknown; props: Record<string, unknown> };
  function elementsOf(tree: unknown, type: unknown): Element[] {
    const out: Element[] = [];
    const visit = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === "object" && "props" in node) {
        const el = node as Element;
        if (el.type === type) out.push(el);
        visit(el.props.children);
      }
    };
    visit(tree);
    return out;
  }
  const itemTitles = (el: Element | undefined) => (el!.props.items as GroupItem[]).map((i) => i.task.title);

  it("shows the plan in order and leaves planned tasks out of the due list", async () => {
    const t = await backlog();
    data(await acceptPlanAction({ taskIds: [t.someday.id, t.dueToday.id] }));

    const tree = await TodayPage();
    expect(itemTitles(elementsOf(tree, PlanSection)[0])).toEqual(["Someday", "Due today"]);
    expect(itemTitles(elementsOf(tree, TaskGroup)[0])).toEqual(["Overdue"]);
  });
});

describe("database constraints", () => {
  it("refuse bad positions, sources, available time and duplicate items", async () => {
    const one = await task("One");
    const [plan] = await db.insert(dayPlans).values({ userId, planDate: TODAY }).returning();
    const item = { userId, dayPlanId: plan!.id, taskId: one.id, source: "manual" as const };

    await expectPgError(db.insert(planItems).values({ ...item, position: -1 }), CHECK_VIOLATION);
    await expectPgError(
      db.insert(planItems).values({ ...item, position: 0, source: "other" as "manual" }),
      CHECK_VIOLATION,
    );
    await expectPgError(db.update(dayPlans).set({ availableMin: 1441 }).where(eq(dayPlans.id, plan!.id)), CHECK_VIOLATION);
    await expectPgError(db.update(dayPlans).set({ availableMin: -1 }).where(eq(dayPlans.id, plan!.id)), CHECK_VIOLATION);
    await db.insert(planItems).values({ ...item, position: 0 });
    await expectPgError(db.insert(planItems).values({ ...item, position: 1 }), UNIQUE_VIOLATION);
    await expectPgError(db.insert(dayPlans).values({ userId, planDate: TODAY }), UNIQUE_VIOLATION);
    await expectPgError(
      db.insert(planItems).values({ ...item, taskId: "00000000-0000-4000-8000-000000000000", position: 1 }),
      FK_VIOLATION,
    );
  });
});
