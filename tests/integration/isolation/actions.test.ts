import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ../next-mocks.
vi.mock("next/headers", async () => (await import("../next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("../next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("../next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("../next-mocks")).reactCache }));

import * as authActions from "@/server/actions/auth";
import * as projectActions from "@/server/actions/projects";
import * as seriesActions from "@/server/actions/series";
import * as settingsActions from "@/server/actions/settings";
import * as taskActions from "@/server/actions/tasks";
import { requireUser } from "@/server/session";
import { actAs, revalidatePath } from "../next-mocks";
import { ACTION_COVERAGE, type ActionCase, type ActionName } from "./registry";
import { seedWorld, snapshotOf, type World } from "./world";

// Signed in as B, every server action is called with A's ids. Each must answer exactly
// "<Entity> not found" (the same as for an id that doesn't exist) and change nothing.

const actions: Record<ActionName, (input?: unknown) => Promise<unknown>> = {
  ...taskActions,
  ...projectActions,
  ...seriesActions,
  ...settingsActions,
  ...authActions,
};

let w: World;

beforeEach(async () => {
  w = await seedWorld();
  actAs(w.b.cookie);
  revalidatePath.mockClear();
});

const cases = Object.entries(ACTION_COVERAGE).flatMap(([action, coverage]) =>
  "cases" in coverage
    ? coverage.cases.map((c): [string, ActionName, ActionCase] => [`${action}: ${c.name}`, action as ActionName, c])
    : [],
);

describe("B calling actions with A's ids gets not-found and changes nothing", () => {
  it.each(cases)("%s", async (_label, action, { name, input, error }) => {
    const aBefore = await snapshotOf(w.a.id);
    // B's session row may legitimately be touched by session validation; B's data may not.
    const bBefore = await snapshotOf(w.b.id, { except: ["sessions"] });

    const result = await actions[action](input(w));

    expect(result, `${action}: ${name}`).toEqual({ ok: false, error });
    expect(await snapshotOf(w.a.id), `${action}: ${name} changed A's data`).toEqual(aBefore);
    expect(await snapshotOf(w.b.id, { except: ["sessions"] }), `${action}: ${name} changed B's data`).toEqual(bBefore);
    expect(revalidatePath, `${action}: ${name} revalidated after a refused write`).not.toHaveBeenCalled();
  });

  it("answers for A's ids exactly as for ids that don't exist", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await actions.updateTaskAction({ id: missing, title: "x" })).toEqual(
      await actions.updateTaskAction({ id: w.a.inboxTask.id, title: "x" }),
    );
    expect(await actions.renameProjectAction({ id: missing, name: "x" })).toEqual(
      await actions.renameProjectAction({ id: w.a.project.id, name: "x" }),
    );
    expect(await actions.deleteSubtaskAction({ id: missing })).toEqual(
      await actions.deleteSubtaskAction({ id: w.a.subtask.id }),
    );
    expect(await actions.updateSeriesAction({ id: missing, title: "x" })).toEqual(
      await actions.updateSeriesAction({ id: w.a.series.id, title: "x" }),
    );
    expect(await actions.skipOccurrenceAction({ id: missing })).toEqual(
      await actions.skipOccurrenceAction({ id: w.a.occurrence.id }),
    );
  });
});

describe("actions that take no ids touch only the caller's data", () => {
  it("create actions ignore a smuggled userId", async () => {
    const aBefore = await snapshotOf(w.a.id);

    const project = await actions.createProjectAction({ name: "mine", userId: w.a.id });
    expect(project).toMatchObject({ ok: true, data: { userId: w.b.id } });
    const task = await actions.createTaskAction({ title: "mine", userId: w.a.id });
    expect(task).toMatchObject({ ok: true, data: { userId: w.b.id, projectId: null } });
    const updated = await actions.updateTaskAction({ id: w.b.inboxTask.id, title: "still mine", userId: w.a.id });
    expect(updated).toMatchObject({ ok: true, data: { userId: w.b.id, title: "still mine" } });
    const series = await actions.createSeriesAction({
      title: "mine",
      userId: w.a.id,
      rule: { kind: "daily", interval: 1, startDate: "2026-01-01" },
    });
    expect(series).toMatchObject({
      ok: true,
      data: { series: { userId: w.b.id, projectId: null }, occurrence: { userId: w.b.id } },
    });

    expect(await snapshotOf(w.a.id)).toEqual(aBefore);
  });

  it("updateSettingsAction writes only the caller's settings, even when sent A's userId", async () => {
    const aBefore = await snapshotOf(w.a.id);

    const result = await actions.updateSettingsAction({
      timeZone: "Pacific/Kiritimati",
      defaultEstimateMin: 45,
      userId: w.a.id,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { userId: w.b.id, timeZone: "Pacific/Kiritimati", defaultEstimateMin: 45 },
    });

    expect(await snapshotOf(w.a.id)).toEqual(aBefore);
  });

  it("signOutAction ends only the caller's session", async () => {
    const aBefore = await snapshotOf(w.a.id);

    await expect(actions.signOutAction()).rejects.toThrow("REDIRECT:/login");

    expect(await snapshotOf(w.a.id)).toEqual(aBefore);
    expect((await snapshotOf(w.b.id)).sessions).toEqual([]);
    actAs(w.a.cookie);
    expect((await requireUser()).id).toBe(w.a.id);
  });
});
