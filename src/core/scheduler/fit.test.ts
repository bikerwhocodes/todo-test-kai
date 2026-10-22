import { describe, expect, it } from "vitest";

import { addDays } from "../dates";
import type { DependencyEdge } from "../graph";
import {
  FIT_RULES,
  suggestPlan,
  type Draft,
  type Priority,
  type SchedulerTask,
  type SuggestPlanInput,
} from "./index";

const TODAY = "2026-10-22";
const T0 = Date.UTC(2026, 0, 1);
const due = (days: number) => addDays(TODAY, days);

function task(id: string, over: Partial<SchedulerTask> = {}): SchedulerTask {
  return {
    id,
    status: "open",
    priority: 4,
    deadline: null,
    estimateMin: 30,
    createdAt: new Date(T0),
    seriesId: null,
    occurrenceDate: null,
    ...over,
  };
}

function plan(tasks: SchedulerTask[], availableMin: number, over: Partial<SuggestPlanInput> = {}): Draft {
  return suggestPlan({ today: TODAY, tasks, edges: [], availableMin, ...over });
}

const ids = (xs: ReadonlyArray<{ task: { id: string } }>) => xs.map((x) => x.task.id);

// Ranked a > b > c > d > e by priority/deadline so the tables read top-down.
const a = (min: number | null) => task("a", { deadline: TODAY, priority: 1, estimateMin: min });
const b = (min: number | null) => task("b", { deadline: due(1), priority: 1, estimateMin: min });
const c = (min: number | null) => task("c", { priority: 1, estimateMin: min });
const d = (min: number | null) => task("d", { priority: 2, estimateMin: min });
const e = (min: number | null) => task("e", { priority: 3, estimateMin: min });

describe("greedy fill", () => {
  it.each<[string, SchedulerTask[], number, string[], number]>([
    ["everything fits", [a(30), b(30), c(30)], 120, ["a", "b", "c"], 90],
    ["exact fit", [a(60), b(60)], 120, ["a", "b"], 120],
    ["stops when full", [a(60), b(60), c(30)], 120, ["a", "b"], 120],
    ["skips a too-big task and keeps filling", [a(60), b(90), c(45)], 120, ["a", "c"], 105],
    ["gap filled by a later, smaller task", [a(100), b(30), c(20)], 120, ["a", "c"], 120],
    ["no estimate uses the default 30", [a(null), b(null), c(null), d(null)], 100, ["a", "b", "c"], 90],
    ["zero estimate is treated as missing", [a(0), b(90)], 120, ["a", "b"], 120],
    ["no candidates", [], 120, [], 0],
  ])("%s", (_name, tasks, available, expected, suggestedMin) => {
    const draft = plan(tasks, available);
    expect(ids(draft.suggestions)).toEqual(expected);
    expect(draft.totals.suggestedMin).toBe(suggestedMin);
    expect(draft.totals.plannedMin).toBeLessThanOrEqual(available);
  });

  it("uses the user's default estimate", () => {
    const draft = plan([a(null), b(null), c(null)], 100, { defaultEstimateMin: 45 });
    expect(ids(draft.suggestions)).toEqual(["a", "b"]);
    expect(draft.totals.suggestedMin).toBe(90);
  });

  it("keeps rank order and 1-based ranks", () => {
    const draft = plan([e(10), d(10), c(200), b(10), a(10)], 60);
    expect(ids(draft.suggestions)).toEqual(["a", "b", "d", "e"]);
    expect(draft.suggestions.map((s) => s.rank)).toEqual([1, 2, 4, 5]);
  });

  it("never exceeds available time (random inputs)", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 100; round++) {
      const tasks = Array.from({ length: 30 }, (_, i) =>
        task(`t${i}`, {
          priority: (1 + Math.floor(rnd() * 4)) as Priority,
          deadline: rnd() < 0.5 ? due(Math.floor(rnd() * 20) - 10) : null,
          estimateMin: rnd() < 0.2 ? null : 5 + Math.floor(rnd() * 180),
        }),
      );
      const inPlanIds = tasks.filter(() => rnd() < 0.1).map((t) => t.id);
      const available = Math.floor(rnd() * 480);
      const draft = plan(tasks, available, { inPlanIds });
      expect(draft.totals.suggestedMin).toBeLessThanOrEqual(Math.max(0, available - draft.totals.existingMin));
      expect(draft.totals.remainingMin).toBeGreaterThanOrEqual(0);
      for (const s of draft.suggestions) expect(inPlanIds).not.toContain(s.task.id);
    }
  });
});

describe("FITS_REMAINING", () => {
  it.each<[string, SchedulerTask[], number, Record<string, number | null>]>([
    // value = remainingMin on the reason, null = no FITS_REMAINING reason
    ["smaller lower-ranked task fills the gap", [a(100), b(30), c(20)], 120, { a: null, c: 20 }],
    ["after a skip, every later pick says so", [a(60), b(90), c(30), d(20)], 120, { a: null, c: 60, d: 30 }],
    ["no skip, no reason", [a(30), b(30)], 120, { a: null, b: null }],
    ["top task skipped", [a(200), b(30)], 120, { b: 120 }],
  ])("%s", (_name, tasks, available, expected) => {
    const draft = plan(tasks, available);
    const got = Object.fromEntries(
      draft.suggestions.map((s) => {
        const r = s.reasons.find((r) => r.code === "FITS_REMAINING");
        return [s.task.id, r && r.code === "FITS_REMAINING" ? r.remainingMin : null];
      }),
    );
    expect(got).toEqual(expected);
  });

  it("is the last reason and adds no points", () => {
    const s = plan([a(100), b(30), c(20)], 120).suggestions[1]!;
    expect(s.reasons.at(-1)).toEqual({ code: "FITS_REMAINING", remainingMin: 20, points: 0 });
    expect(s.score).toBe(40); // P1 only
  });
});

describe("didn't fit", () => {
  it.each<[string, SchedulerTask[], number, Partial<SuggestPlanInput>, Array<[string, unknown]>]>([
    [
      "top-ranked task bigger than all available time",
      [a(180), b(30)],
      120,
      {},
      [["a", { code: "TOO_LARGE", needMin: 180, availableMin: 120 }]],
    ],
    [
      "fits alone but higher picks used the time",
      [a(90), b(60), c(30)],
      120,
      {},
      [["b", { code: "NO_ROOM_LEFT", needMin: 60, remainingMin: 30 }]],
    ],
    [
      "TOO_LARGE compares against time after the existing plan",
      [a(100), task("p", { estimateMin: 60 })],
      120,
      { inPlanIds: ["p"] },
      [["a", { code: "TOO_LARGE", needMin: 100, availableMin: 60 }]],
    ],
    [
      "urgent task below the top ranks is still listed",
      [
        ...Array.from({ length: FIT_RULES.didntFitTopRanks + 2 }, (_, i) =>
          task(`hi${i}`, { deadline: due(-3), priority: 1, estimateMin: 10 }),
        ),
        task("urgent", { deadline: TODAY, priority: 4, estimateMin: 500 }),
        task("later", { priority: 4, estimateMin: 500 }),
      ],
      200,
      {},
      [["urgent", { code: "TOO_LARGE", needMin: 500, availableMin: 200 }]],
    ],
    [
      "overdue counts as urgent",
      [
        ...Array.from({ length: FIT_RULES.didntFitTopRanks }, (_, i) => task(`hi${i}`, { deadline: due(-3), estimateMin: 5 })),
        task("late", { deadline: due(-1), estimateMin: 300 }),
      ],
      60,
      {},
      [["late", { code: "TOO_LARGE", needMin: 300, availableMin: 60 }]],
    ],
    [
      "stale overdue below the top ranks is not urgent",
      [
        ...Array.from({ length: FIT_RULES.didntFitTopRanks }, (_, i) =>
          task(`hi${i}`, { deadline: due(2), priority: 1, estimateMin: 5 }),
        ),
        task("stale", { deadline: due(-30), estimateMin: 300 }),
      ],
      60,
      {},
      [],
    ],
    [
      "oversized low-ranked, non-urgent task is skipped silently",
      [
        ...Array.from({ length: FIT_RULES.didntFitTopRanks }, (_, i) => task(`hi${i}`, { priority: 1, estimateMin: 5 })),
        task("big", { priority: 4, estimateMin: 300 }),
      ],
      60,
      {},
      [],
    ],
  ])("%s", (_name, tasks, available, over, expected) => {
    const draft = plan(tasks, available, over);
    expect(draft.didntFit.map((x) => [x.task.id, x.size])).toEqual(expected);
    for (const x of draft.didntFit) expect(ids(draft.suggestions)).not.toContain(x.task.id);
  });

  it("keeps the candidate's own reasons and rank", () => {
    const [x] = plan([a(180), b(30)], 120).didntFit;
    expect(x!.rank).toBe(1);
    expect(x!.reasons.map((r) => r.code)).toEqual(["DUE_TODAY", "PRIORITY"]);
  });
});

describe("nothing fits", () => {
  it.each<[string, SchedulerTask[], number, Partial<SuggestPlanInput>, string[] | null]>([
    ["shortest three, shortest first", [a(90), b(60), c(120), d(45), e(200)], 30, {}, ["d", "b", "a"]],
    ["ties on length keep rank order", [c(60), a(60), b(60), d(60)], 30, {}, ["a", "b", "c"]],
    ["fewer than three candidates", [a(90), b(60)], 30, {}, ["b", "a"]],
    ["zero minutes available", [a(30)], 0, {}, ["a"]],
    ["existing plan uses all the time", [a(15), task("p", { estimateMin: 120 })], 120, { inPlanIds: ["p"] }, ["a"]],
    ["something fits: no hints", [a(90), b(20)], 30, {}, null],
    ["no candidates: no hints", [task("x", { status: "done" })], 30, {}, null],
  ])("%s", (_name, tasks, available, over, expected) => {
    const draft = plan(tasks, available, over);
    expect(draft.nothingFits && ids(draft.nothingFits.shortest)).toEqual(expected);
    if (expected) expect(draft.suggestions).toEqual([]);
  });

  it("hints carry a size reason against the time left", () => {
    const draft = plan([a(90), b(45)], 30);
    expect(draft.nothingFits!.shortest.map((x) => [x.task.id, x.rank, x.size])).toEqual([
      ["b", 2, { code: "TOO_LARGE", needMin: 45, availableMin: 30 }],
      ["a", 1, { code: "TOO_LARGE", needMin: 90, availableMin: 30 }],
    ]);
  });
});

describe("adding to an existing plan", () => {
  it.each<[string, SchedulerTask[], number, string[], string[], Partial<Draft["totals"]>]>([
    [
      "existing minutes are subtracted",
      [task("p1", { estimateMin: 60 }), a(30), b(30), c(30)],
      120,
      ["p1"],
      ["a", "b"],
      { existingMin: 60, existingCount: 1, suggestedMin: 60, plannedMin: 120, remainingMin: 0, overMin: 0 },
    ],
    [
      "existing item with no estimate counts at the default, as assumed",
      [task("p1", { estimateMin: null }), a(60), b(60)],
      120,
      ["p1"],
      ["a"],
      { existingMin: 30, suggestedMin: 60, plannedMin: 90, remainingMin: 30, assumedCount: 1 },
    ],
    [
      "done items in the plan don't use time",
      [task("p1", { estimateMin: 60, status: "done" }), a(60), b(60)],
      120,
      ["p1"],
      ["a", "b"],
      { existingMin: 0, existingCount: 0, suggestedMin: 120 },
    ],
    [
      "unknown plan ids count at the default",
      [a(60), b(60)],
      120,
      ["gone"],
      ["a"],
      { existingMin: 30, existingCount: 1, assumedCount: 1 },
    ],
    [
      "duplicate plan ids count once",
      [task("p1", { estimateMin: 30 }), a(60)],
      120,
      ["p1", "p1"],
      ["a"],
      { existingMin: 30, existingCount: 1, plannedMin: 90 },
    ],
    [
      "existing plan already over: nothing new, overMin reported",
      [task("p1", { estimateMin: 150 }), a(10)],
      120,
      ["p1"],
      [],
      { existingMin: 150, suggestedMin: 0, plannedMin: 150, remainingMin: 0, overMin: 30 },
    ],
  ])("%s", (_name, tasks, available, inPlanIds, expected, totals) => {
    const draft = plan(tasks, available, { inPlanIds });
    expect(ids(draft.suggestions)).toEqual(expected);
    expect(draft.totals).toMatchObject(totals);
    for (const id of inPlanIds) {
      expect(ids(draft.suggestions)).not.toContain(id);
      expect(ids(draft.didntFit)).not.toContain(id);
    }
  });
});

describe("totals", () => {
  it.each<[string, SchedulerTask[], number, Partial<SuggestPlanInput>, Draft["totals"]]>([
    [
      "counts assumed estimates across existing and suggested",
      [task("p", { estimateMin: null }), a(null), b(20), c(null)],
      120,
      { inPlanIds: ["p"] },
      {
        availableMin: 120,
        existingMin: 30,
        existingCount: 1,
        suggestedMin: 80,
        suggestedCount: 3,
        plannedMin: 110,
        remainingMin: 10,
        overMin: 0,
        assumedCount: 3,
      },
    ],
    [
      "assumed tasks that didn't fit are not counted",
      [a(100), b(null)],
      110,
      {},
      {
        availableMin: 110,
        existingMin: 0,
        existingCount: 0,
        suggestedMin: 100,
        suggestedCount: 1,
        plannedMin: 100,
        remainingMin: 10,
        overMin: 0,
        assumedCount: 0,
      },
    ],
  ])("%s", (_name, tasks, available, over, totals) => {
    expect(plan(tasks, available, over).totals).toEqual(totals);
  });

  it("passes the candidate filter's exclusions through", () => {
    const draft = plan([a(30), task("x", { status: "done" })], 60, { inPlanIds: ["a"] });
    expect(draft.excluded).toEqual([
      { id: "a", reason: "in_plan" },
      { id: "x", reason: "done" },
    ]);
  });
});

describe("input validation", () => {
  it.each([
    ["negative available", -1],
    ["NaN available", Number.NaN],
    ["infinite available", Number.POSITIVE_INFINITY],
  ])("%s throws RangeError", (_name, available) => {
    expect(() => plan([a(30)], available)).toThrow(RangeError);
  });
});

describe("performance", () => {
  it("1,000 tasks in < 50 ms", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const tasks = Array.from({ length: 1000 }, (_, i) =>
      task(`t${String(i).padStart(4, "0")}`, {
        status: rnd() < 0.1 ? "done" : "open",
        priority: (1 + Math.floor(rnd() * 4)) as Priority,
        deadline: rnd() < 0.6 ? due(Math.floor(rnd() * 40) - 20) : null,
        estimateMin: rnd() < 0.3 ? null : 5 + Math.floor(rnd() * 240),
        createdAt: new Date(T0 + Math.floor(rnd() * 1e9)),
        ...(rnd() < 0.1 ? { seriesId: "s", occurrenceDate: due(Math.floor(rnd() * 6) - 3) } : {}),
      }),
    );
    const edges: DependencyEdge[] = Array.from({ length: 1000 }, () => ({
      taskId: `t${String(Math.floor(rnd() * 1000)).padStart(4, "0")}`,
      blockedById: `t${String(Math.floor(rnd() * 1000)).padStart(4, "0")}`,
    }));
    const input: SuggestPlanInput = {
      today: TODAY,
      tasks,
      edges,
      availableMin: 480,
      inPlanIds: tasks.slice(0, 20).map((t) => t.id),
      carriedOverIds: tasks.slice(20, 60).map((t) => t.id),
    };
    suggestPlan(input); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      suggestPlan(input);
      times.push(performance.now() - start);
    }
    times.sort((x, y) => x - y);
    expect(times[2]!).toBeLessThan(50);
  });
});
