import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ./next-mocks.
vi.mock("next/headers", async () => (await import("./next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("./next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("./next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("./next-mocks")).reactCache }));

import { db } from "@/server/db";
import { recurringSeries, tasks } from "@/server/db/schema";
import { rememberAvailableTimeAction, updateSettingsAction } from "@/server/actions/settings";
import { listDueTasks, listUpcomingTasks } from "@/server/repo/agenda";
import { createSeries, skipOccurrence } from "@/server/repo/series";
import { createTask, setTaskCompleted, updateTask } from "@/server/repo/tasks";
import { getUserSettings, getUserToday, setLastAvailableMin, updateUserSettings } from "@/server/repo/user-settings";
import { createUser, resetDb } from "./helpers";
import { snapshotOf } from "./isolation/world";
import { actAs, revalidatePath } from "./next-mocks";
import { signUp } from "./session-helpers";

// Settings (spec §7): changing the zone moves only the Today/Upcoming boundaries,
// never a stored date.

const LA = "America/Los_Angeles";
const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14
// 13:00 on 10-22 in Los Angeles (PDT), 10:00 on 10-23 in Kiritimati.
const NOW = new Date("2026-10-22T20:00:00Z");

let userId: string;

beforeEach(async () => {
  await resetDb();
  revalidatePath.mockClear();
  const user = await signUp("ada@example.com", { timeZone: LA });
  actAs(user.cookie);
  userId = user.id;
});

const ids = (list: { id: string }[]) => list.map((t) => t.id);

async function oneOff(title: string, deadline: string) {
  const task = await createTask(userId, { title });
  return updateTask(userId, task.id, { deadline });
}

/** Every task and series row the user owns, whole, in a stable order. */
async function datedRows() {
  const [taskRows, seriesRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.userId, userId)).orderBy(asc(tasks.id)),
    db.select().from(recurringSeries).where(eq(recurringSeries.userId, userId)).orderBy(asc(recurringSeries.id)),
  ]);
  return { taskRows, seriesRows };
}

describe("changing the time zone", () => {
  it("leaves every deadline, occurrence date and series date unchanged", async () => {
    await oneOff("Overdue", "2026-10-01");
    await oneOff("Today in LA", "2026-10-22");
    await oneOff("Tomorrow in LA", "2026-10-23");
    await oneOff("New Year's Eve", "2026-12-31");
    const done = await oneOff("Done already", "2026-10-21");
    await setTaskCompleted(userId, done.id, true, "2026-10-22");

    // Daily from 10-20: 10-20 done, 10-21 skipped, 10-22 open.
    const { occurrence: first } = await createSeries(
      userId,
      { title: "Stretch", rule: { kind: "daily", interval: 1, weekdays: null, startDate: "2026-10-20", endDate: "2026-12-31" } },
      "2026-10-20",
    );
    await setTaskCompleted(userId, first!.id, true, "2026-10-20");
    const [second] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.occurrenceDate, "2026-10-21")));
    await skipOccurrence(userId, second!.id, "2026-10-21");
    // Weekly Mon/Fri, first occurrence in the future.
    await createSeries(
      userId,
      { title: "Gym", rule: { kind: "weekly", interval: 1, weekdays: [1, 5], startDate: "2026-10-23", endDate: null } },
      "2026-10-22",
    );

    const before = await datedRows();
    expect(before.taskRows).toHaveLength(9);
    expect(before.seriesRows).toHaveLength(2);
    expect(before.taskRows.map((t) => [t.title, t.status, t.deadline, t.occurrenceDate]).sort()).toEqual(
      [
        ["Done already", "done", "2026-10-21", null],
        ["Gym", "open", "2026-10-23", "2026-10-23"],
        ["New Year's Eve", "open", "2026-12-31", null],
        ["Overdue", "open", "2026-10-01", null],
        ["Stretch", "done", "2026-10-20", "2026-10-20"],
        ["Stretch", "open", "2026-10-22", "2026-10-22"],
        ["Stretch", "skipped", "2026-10-21", "2026-10-21"],
        ["Today in LA", "open", "2026-10-22", null],
        ["Tomorrow in LA", "open", "2026-10-23", null],
      ].sort(),
    );

    const result = await updateSettingsAction({ timeZone: KIRITIMATI });
    expect(result).toMatchObject({ ok: true, data: { userId, timeZone: KIRITIMATI } });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");

    // Whole rows, updated_at included: the zone change wrote to neither table.
    expect(await datedRows()).toEqual(before);
    expect((await getUserSettings(userId)).timeZone).toBe(KIRITIMATI);

    // And back again: still nothing moves.
    expect(await updateSettingsAction({ timeZone: LA })).toMatchObject({ ok: true, data: { timeZone: LA } });
    expect(await datedRows()).toEqual(before);
  });

  it("moves the Today and Upcoming boundaries right away", async () => {
    const tomorrow = await oneOff("Due 10-23", "2026-10-23");
    const lastDay = await oneOff("Due 11-05", "2026-11-05");
    const { occurrence } = await createSeries(
      userId,
      { title: "Daily from 10-23", rule: { kind: "daily", interval: 1, weekdays: null, startDate: "2026-10-23", endDate: null } },
      "2026-10-22",
    );
    expect(occurrence!.occurrenceDate).toBe("2026-10-23");

    // Los Angeles: today is 10-22, Upcoming is 10-22..11-04.
    let today = await getUserToday(userId, NOW);
    expect(today).toBe("2026-10-22");
    expect(ids(await listUpcomingTasks(userId, today)).sort()).toEqual([tomorrow.id, occurrence!.id].sort());
    expect(await listDueTasks(userId, today)).toEqual([]);

    expect(await updateSettingsAction({ timeZone: KIRITIMATI })).toMatchObject({ ok: true });

    // Kiritimati, same instant: today is 10-23, Upcoming is 10-23..11-05.
    today = await getUserToday(userId, NOW);
    expect(today).toBe("2026-10-23");
    expect(ids(await listDueTasks(userId, today)).sort()).toEqual([tomorrow.id, occurrence!.id].sort());
    expect(ids(await listUpcomingTasks(userId, today)).sort()).toEqual(
      [tomorrow.id, occurrence!.id, lastDay.id].sort(),
    );
  });
});

describe("validation", () => {
  it.each([
    ["an unknown zone", { timeZone: "Mars/Olympus_Mons" }],
    ["a raw offset", { timeZone: "+05:30" }],
    ["an empty zone", { timeZone: "" }],
    ["a zero estimate", { defaultEstimateMin: 0 }],
    ["an estimate over 24 hours", { defaultEstimateMin: 1441 }],
    ["a fractional estimate", { defaultEstimateMin: 1.5 }],
    ["a valid zone with a bad estimate", { timeZone: KIRITIMATI, defaultEstimateMin: 0 }],
    ["an empty object", {}],
    ["no input", undefined],
  ])("rejects %s and changes nothing", async (_label, input) => {
    const before = await getUserSettings(userId);

    const result = await updateSettingsAction(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.any(String));
    expect(await getUserSettings(userId)).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("names the offending field", async () => {
    expect(await updateSettingsAction({ timeZone: "+05:30" })).toMatchObject({
      ok: false,
      fieldErrors: { timeZone: ["Choose a time zone from the list"] },
    });
    expect(await updateSettingsAction({})).toMatchObject({ ok: false, error: "Nothing to update" });
  });

  it("requires a session", async () => {
    actAs(null);
    await expect(updateSettingsAction({ timeZone: KIRITIMATI })).rejects.toThrow("REDIRECT:/login");
    expect((await getUserSettings(userId)).timeZone).toBe(LA);
  });
});

describe("partial updates", () => {
  it("keeps the field that was left out", async () => {
    const initial = await getUserSettings(userId);
    expect(initial).toMatchObject({ timeZone: LA, defaultEstimateMin: 30 });

    const estimate = await updateSettingsAction({ defaultEstimateMin: 45 });
    expect(estimate).toMatchObject({ ok: true, data: { timeZone: LA, defaultEstimateMin: 45 } });

    const zone = await updateSettingsAction({ timeZone: KIRITIMATI });
    expect(zone).toMatchObject({ ok: true, data: { timeZone: KIRITIMATI, defaultEstimateMin: 45 } });

    const stored = await getUserSettings(userId);
    expect(stored).toMatchObject({ timeZone: KIRITIMATI, defaultEstimateMin: 45, lastAvailableMin: initial.lastAvailableMin });
    expect(stored.createdAt).toEqual(initial.createdAt);
    expect(stored.updatedAt.getTime()).toBeGreaterThanOrEqual(initial.updatedAt.getTime());
  });

  it("ignores a smuggled userId and only writes the caller's row", async () => {
    const other = await signUp("bob@example.com", { timeZone: "Asia/Tokyo" });
    actAs((await signUp("cy@example.com", { timeZone: LA })).cookie);

    expect(await updateSettingsAction({ timeZone: KIRITIMATI, userId: other.id })).toMatchObject({ ok: true });
    expect((await getUserSettings(other.id)).timeZone).toBe("Asia/Tokyo");
    expect((await getUserSettings(userId)).timeZone).toBe(LA);
  });

  it("creates the settings row if the signup hook never did", async () => {
    const bare = await createUser("Bare");
    const row = await updateUserSettings(bare, { defaultEstimateMin: 15 });
    expect(row).toMatchObject({ userId: bare, timeZone: "UTC", defaultEstimateMin: 15 });
  });
});

describe("remembering Plan My Day's available time", () => {
  it("writes only user_settings.last_available_min (and updated_at)", async () => {
    await oneOff("Something to plan", "2026-10-22");
    const settingsBefore = await getUserSettings(userId);
    const before = await snapshotOf(userId, { except: ["sessions", "user_settings"] });

    expect(await rememberAvailableTimeAction({ availableMin: 150 })).toEqual({ ok: true, data: undefined });

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(await snapshotOf(userId, { except: ["sessions", "user_settings"] })).toEqual(before);
    const stored = await getUserSettings(userId);
    expect(stored).toEqual({ ...settingsBefore, lastAvailableMin: 150, updatedAt: expect.any(Date) });
    expect(stored.updatedAt.getTime()).toBeGreaterThanOrEqual(settingsBefore.updatedAt.getTime());

    // Zero is a valid choice ("no time today") and overwrites the last one.
    expect(await rememberAvailableTimeAction({ availableMin: 0 })).toMatchObject({ ok: true });
    expect((await getUserSettings(userId)).lastAvailableMin).toBe(0);
  });

  it.each([
    ["negative time", { availableMin: -1 }],
    ["more than 24 hours", { availableMin: 1441 }],
    ["fractional minutes", { availableMin: 1.5 }],
    ["a string", { availableMin: "60" }],
    ["an empty object", {}],
    ["no input", undefined],
  ])("rejects %s and changes nothing", async (_label, input) => {
    await setLastAvailableMin(userId, 90);
    const before = await getUserSettings(userId);

    const result = await rememberAvailableTimeAction(input);

    expect(result.ok).toBe(false);
    expect(await getUserSettings(userId)).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    actAs(null);
    await expect(rememberAvailableTimeAction({ availableMin: 60 })).rejects.toThrow("REDIRECT:/login");
    expect((await getUserSettings(userId)).lastAvailableMin).toBeNull();
  });

  it("creates the settings row if the signup hook never did", async () => {
    const bare = await createUser("Bare");
    await setLastAvailableMin(bare, 45);
    expect(await getUserSettings(bare)).toMatchObject({ userId: bare, timeZone: "UTC", lastAvailableMin: 45 });
  });
});
