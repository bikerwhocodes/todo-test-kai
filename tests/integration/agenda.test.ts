import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ./next-mocks.
vi.mock("next/headers", async () => (await import("./next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("./next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("./next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("./next-mocks")).reactCache }));

import { eq } from "drizzle-orm";
import TodayPage from "@/app/(app)/today/page";
import UpcomingPage from "@/app/(app)/upcoming/page";
import { TaskGroup, type GroupItem } from "@/components/tasks/task-group";
import { PlanSection } from "@/components/today/plan-section";
import { db } from "@/server/db";
import { tasks } from "@/server/db/schema";
import { listDueTasks, listUpcomingTasks } from "@/server/repo/agenda";
import { createProject } from "@/server/repo/projects";
import { addSubtask } from "@/server/repo/subtasks";
import { createTask, setTaskCompleted, updateTask } from "@/server/repo/tasks";
import { createUser, resetDb } from "./helpers";
import { stringsIn } from "./isolation/world";
import { actAs } from "./next-mocks";
import { signUp } from "./session-helpers";

const titles = (list: { title: string }[]) => list.map((t) => t.title);

/** Creates an open task with `deadline`; `status` other than open is applied afterwards. */
async function seedTask(
  userId: string,
  title: string,
  deadline: string | null,
  { status = "open", projectId = null }: { status?: "open" | "done" | "skipped"; projectId?: string | null } = {},
) {
  const task = await createTask(userId, { title, projectId });
  if (deadline) await updateTask(userId, task.id, { deadline });
  if (status === "done") await setTaskCompleted(userId, task.id, true);
  // Nothing sets "skipped" yet (series will); write it directly.
  if (status === "skipped") await db.update(tasks).set({ status: "skipped" }).where(eq(tasks.id, task.id));
  return task;
}

describe("repo", () => {
  let userId: string;
  const today = "2026-10-22";

  beforeEach(async () => {
    await resetDb();
    userId = await createUser("Ada");
  });

  it("listUpcomingTasks returns open tasks due up to today + 13 (overdue included), by deadline", async () => {
    const project = await createProject(userId, { name: "Home" });
    await seedTask(userId, "day 14", "2026-11-05");
    await seedTask(userId, "day 13", "2026-11-04", { projectId: project.id });
    await seedTask(userId, "today", today);
    await seedTask(userId, "long overdue", "2025-01-01");
    await seedTask(userId, "yesterday", "2026-10-21");
    await seedTask(userId, "no deadline", null);
    await seedTask(userId, "done overdue", "2026-10-01", { status: "done" });
    await seedTask(userId, "done today", today, { status: "done" });
    await seedTask(userId, "skipped tomorrow", "2026-10-23", { status: "skipped" });

    expect(titles(await listUpcomingTasks(userId, today))).toEqual(["long overdue", "yesterday", "today", "day 13"]);
    expect(titles(await listUpcomingTasks(userId, today, 1))).toEqual(["long overdue", "yesterday", "today"]);
  });

  it("listDueTasks returns open tasks due today or earlier, oldest first", async () => {
    await seedTask(userId, "tomorrow", "2026-10-23");
    await seedTask(userId, "today", today);
    await seedTask(userId, "yesterday", "2026-10-21");
    await seedTask(userId, "no deadline", null);
    await seedTask(userId, "done yesterday", "2026-10-21", { status: "done" });
    await seedTask(userId, "skipped today", today, { status: "skipped" });

    expect(titles(await listDueTasks(userId, today))).toEqual(["yesterday", "today"]);
  });

  it("orders tasks due the same day like their lists, and attaches subtasks", async () => {
    const first = await seedTask(userId, "first", today);
    const second = await seedTask(userId, "second", today);
    await db.update(tasks).set({ sort: -1 }).where(eq(tasks.id, second.id));
    const sub = await addSubtask(userId, first.id, "step");

    const due = await listDueTasks(userId, today);
    expect(titles(due)).toEqual(["second", "first"]);
    expect(due[1]!.subtasks.map((s) => s.id)).toEqual([sub.id]);
    expect(due[0]!.subtasks).toEqual([]);
  });

  it("returns the deadline as the stored YYYY-MM-DD string", async () => {
    await seedTask(userId, "new year", "2027-01-01");
    const [row] = await listUpcomingTasks(userId, "2026-12-31");
    expect(row!.deadline).toBe("2027-01-01");
  });

  it("rejects a malformed today instead of comparing it as text", async () => {
    await expect(listDueTasks(userId, "2026-10-32")).rejects.toThrow(RangeError);
    await expect(listUpcomingTasks(userId, "22/10/2026")).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------
// Pages, at one instant for two users in different zones.

type Element = { type: unknown; props: Record<string, unknown> };

/** Every element of `type` in a server-rendered tree (component functions are not called). */
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

/** TaskGroups as [heading, [title, overdueBy][]]. */
function groupsOf(tree: unknown) {
  return elementsOf(tree, TaskGroup).map((el) => [
    el.props.heading,
    (el.props.items as GroupItem[]).map((i) => [i.task.title, i.overdueBy ?? null]),
  ]);
}

describe("pages follow the user's profile time zone", () => {
  // 23:30 on Sat 31 Oct in Los Angeles; 15:30 on Sun 1 Nov in Tokyo.
  const NOW = new Date("2026-11-01T06:30:00Z");

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await resetDb();
    actAs(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Signs up a user in `timeZone` with the same set of tasks, and signs them in. */
  async function userIn(email: string, timeZone: string) {
    const user = await signUp(email, { timeZone });
    await seedTask(user.id, "Oct 30", "2026-10-30");
    await seedTask(user.id, "Oct 31", "2026-10-31");
    await seedTask(user.id, "Nov 1", "2026-11-01");
    await seedTask(user.id, "Nov 13", "2026-11-13");
    await seedTask(user.id, "Nov 14", "2026-11-14");
    await seedTask(user.id, "No deadline", null);
    await seedTask(user.id, "Done Oct 30", "2026-10-30", { status: "done" });
    await seedTask(user.id, "Skipped Nov 1", "2026-11-01", { status: "skipped" });
    actAs(user.cookie);
    return user;
  }

  it.each([
    {
      email: "la@example.com",
      tz: "America/Los_Angeles",
      upcoming: [
        ["Overdue", [["Oct 30", "1 day overdue"]]],
        ["Today · Sat 31 Oct", [["Oct 31", null]]],
        ["Tomorrow · Sun 1 Nov", [["Nov 1", null]]],
        ["Fri 13 Nov", [["Nov 13", null]]],
        // Nov 14 is today + 14: outside the window.
      ],
      due: [["Oct 30", "1 day overdue"], ["Oct 31", null]],
    },
    {
      email: "tokyo@example.com",
      tz: "Asia/Tokyo",
      upcoming: [
        [
          "Overdue",
          [
            ["Oct 30", "2 days overdue"],
            ["Oct 31", "1 day overdue"],
          ],
        ],
        ["Today · Sun 1 Nov", [["Nov 1", null]]],
        ["Fri 13 Nov", [["Nov 13", null]]],
        ["Sat 14 Nov", [["Nov 14", null]]],
      ],
      due: [["Oct 30", "2 days overdue"], ["Oct 31", "1 day overdue"], ["Nov 1", null]],
    },
  ])("$tz", async ({ email, tz, upcoming, due }) => {
    await userIn(email, tz);

    expect(groupsOf(await UpcomingPage())).toEqual(upcoming);

    const today = await TodayPage();
    expect(groupsOf(today)).toEqual([["Due today & overdue, not in plan", due]]);
    const [plan] = elementsOf(today, PlanSection);
    expect(plan!.props.items).toEqual([]);
  });

  it("show empty states when nothing is due", async () => {
    const user = await signUp("empty@example.com", { timeZone: "Europe/Berlin" });
    await seedTask(user.id, "Later", "2026-12-01");
    await seedTask(user.id, "Someday", null);
    actAs(user.cookie);

    const upcoming = await UpcomingPage();
    expect(elementsOf(upcoming, TaskGroup)).toEqual([]);
    expect(stringsIn(upcoming)).toContain("Nothing due in the next ");

    const today = await TodayPage();
    expect(elementsOf(today, TaskGroup).map((g) => [g.props.items, g.props.emptyText])).toEqual([
      [[], "Nothing due today or overdue."],
    ]);
  });
});
