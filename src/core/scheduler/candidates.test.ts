import { describe, expect, it } from "vitest";

import { addDays } from "../dates";
import { blockedSet, type DependencyEdge } from "../graph";
import {
  CARRIED_OVER_POINTS,
  compareCandidates,
  rankCandidates,
  type CandidateInput,
  type Priority,
  type RankedCandidate,
  type SchedulerTask,
} from "./index";

const TODAY = "2026-10-22";
const T0 = Date.UTC(2026, 0, 1);

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

const due = (days: number) => addDays(TODAY, days);

function rank(tasks: SchedulerTask[], over: Partial<CandidateInput> = {}) {
  return rankCandidates({ today: TODAY, tasks, edges: [], ...over });
}

const ids = (ranked: ReadonlyArray<RankedCandidate>) => ranked.map((c) => c.task.id);

function only(t: SchedulerTask, over: Partial<CandidateInput> = {}): RankedCandidate {
  const { ranked } = rank([t], over);
  expect(ranked).toHaveLength(1);
  return ranked[0]!;
}

describe("candidate filter", () => {
  it.each<[string, SchedulerTask[], Partial<CandidateInput>, string, string | null]>([
    ["done", [task("a", { status: "done" })], {}, "a", "done"],
    ["skipped", [task("a", { status: "skipped" })], {}, "a", "done"],
    ["already in plan", [task("a")], { inPlanIds: ["a"] }, "a", "in_plan"],
    ["dismissed today", [task("a")], { dismissedIds: ["a"] }, "a", "dismissed"],
    ["future occurrence", [task("a", { seriesId: "s", occurrenceDate: due(1) })], {}, "a", "future_occurrence"],
    ["occurrence today", [task("a", { seriesId: "s", occurrenceDate: TODAY })], {}, "a", null],
    ["missed occurrence", [task("a", { seriesId: "s", occurrenceDate: due(-2) })], {}, "a", null],
    [
      "blocked by an open task",
      [task("a"), task("b")],
      { edges: [{ taskId: "a", blockedById: "b" }] },
      "a",
      "blocked",
    ],
    [
      "blocker is done",
      [task("a"), task("b", { status: "done" })],
      { edges: [{ taskId: "a", blockedById: "b" }] },
      "a",
      null,
    ],
    ["blocker not loaded", [task("a")], { edges: [{ taskId: "a", blockedById: "gone" }] }, "a", null],
    [
      "blocker is in the plan (still open, still blocks)",
      [task("a"), task("b")],
      { edges: [{ taskId: "a", blockedById: "b" }], inPlanIds: ["b"] },
      "a",
      "blocked",
    ],
    ["done wins over in plan", [task("a", { status: "done" })], { inPlanIds: ["a"] }, "a", "done"],
  ])("%s", (_name, tasks, over, id, expected) => {
    const { ranked, excluded } = rank(tasks, over);
    const ex = excluded.find((e) => e.id === id);
    if (expected === null) {
      expect(ex).toBeUndefined();
      expect(ids(ranked)).toContain(id);
    } else {
      expect(ex?.reason).toBe(expected);
      expect(ids(ranked)).not.toContain(id);
    }
  });

  it("never ranks a blocked task (random graphs)", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 50; round++) {
      const tasks = Array.from({ length: 40 }, (_, i) =>
        task(`t${i}`, {
          status: rnd() < 0.2 ? "done" : "open",
          priority: (1 + Math.floor(rnd() * 4)) as Priority,
          deadline: rnd() < 0.7 ? due(Math.floor(rnd() * 40) - 30) : null,
        }),
      );
      const edges: DependencyEdge[] = Array.from({ length: 60 }, () => ({
        taskId: `t${Math.floor(rnd() * 40)}`,
        blockedById: `t${Math.floor(rnd() * 40)}`,
      }));
      const blocked = blockedSet(
        tasks.map((t) => ({ id: t.id, open: t.status === "open" })),
        edges,
      );
      const { ranked } = rank(tasks, { edges });
      for (const c of ranked) expect(blocked.has(c.task.id)).toBe(false);
    }
  });
});

describe("score table", () => {
  it.each<[string, Partial<SchedulerTask>, Partial<CandidateInput>, number, unknown[]]>([
    ["no deadline, P4", {}, {}, 0, []],
    ["overdue 1d", { deadline: due(-1) }, {}, 100, [{ code: "OVERDUE", days: 1, points: 100 }]],
    ["overdue 3d", { deadline: due(-3) }, {}, 110, [{ code: "OVERDUE", days: 3, points: 110 }]],
    ["overdue 7d hits the cap", { deadline: due(-7) }, {}, 130, [{ code: "OVERDUE", days: 7, points: 130 }]],
    ["overdue 14d still overdue", { deadline: due(-14) }, {}, 130, [{ code: "OVERDUE", days: 14, points: 130 }]],
    ["overdue 15d is stale", { deadline: due(-15) }, {}, 40, [{ code: "STALE_OVERDUE", days: 15, points: 40 }]],
    ["overdue 30d is stale", { deadline: due(-30) }, {}, 40, [{ code: "STALE_OVERDUE", days: 30, points: 40 }]],
    ["due today", { deadline: TODAY }, {}, 80, [{ code: "DUE_TODAY", points: 80 }]],
    ["due tomorrow", { deadline: due(1) }, {}, 60, [{ code: "DUE_TOMORROW", points: 60 }]],
    ["due in 2d", { deadline: due(2) }, {}, 50, [{ code: "DUE_IN", days: 2, points: 50 }]],
    ["due in 7d", { deadline: due(7) }, {}, 25, [{ code: "DUE_IN", days: 7, points: 25 }]],
    ["due in 8d scores nothing", { deadline: due(8) }, {}, 0, []],
    ["P1", { priority: 1 }, {}, 40, [{ code: "PRIORITY", priority: 1, points: 40 }]],
    ["P2", { priority: 2 }, {}, 25, [{ code: "PRIORITY", priority: 2, points: 25 }]],
    ["P3", { priority: 3 }, {}, 10, [{ code: "PRIORITY", priority: 3, points: 10 }]],
    ["carried over", {}, { carriedOverIds: ["x"] }, 5, [{ code: "CARRIED_OVER", points: 5 }]],
    [
      "recurring occurrence uses occurrenceDate as due date",
      { seriesId: "s", occurrenceDate: TODAY },
      {},
      80,
      [
        { code: "DUE_TODAY", points: 80 },
        { code: "RECURRING", points: 0 },
      ],
    ],
    [
      "deadline wins over occurrenceDate",
      { seriesId: "s", occurrenceDate: TODAY, deadline: due(1) },
      {},
      60,
      [
        { code: "DUE_TOMORROW", points: 60 },
        { code: "RECURRING", points: 0 },
      ],
    ],
    [
      "no estimate uses the default",
      { estimateMin: null },
      { defaultEstimateMin: 45 },
      0,
      [{ code: "ASSUMED_ESTIMATE", minutes: 45, points: 0 }],
    ],
    [
      "all rows in table order",
      { deadline: due(-2), priority: 2, estimateMin: null, seriesId: "s", occurrenceDate: due(-2) },
      { carriedOverIds: ["x"] },
      105 + 25 + 5,
      [
        { code: "OVERDUE", days: 2, points: 105 },
        { code: "PRIORITY", priority: 2, points: 25 },
        { code: "CARRIED_OVER", points: 5 },
        { code: "RECURRING", points: 0 },
        { code: "ASSUMED_ESTIMATE", minutes: 30, points: 0 },
      ],
    ],
  ])("%s", (_name, over, input, score, reasons) => {
    const c = only(task("x", over), input);
    expect(c.score).toBe(score);
    expect(c.reasons).toEqual(reasons);
  });

  it.each<[string, DependencyEdge[], SchedulerTask[], number]>([
    ["one open dependent", [{ taskId: "d1", blockedById: "x" }], [task("d1")], 10],
    [
      "three open dependents",
      ["d1", "d2", "d3"].map((d) => ({ taskId: d, blockedById: "x" })),
      ["d1", "d2", "d3"].map((d) => task(d)),
      30,
    ],
    [
      "capped at 30",
      ["d1", "d2", "d3", "d4"].map((d) => ({ taskId: d, blockedById: "x" })),
      ["d1", "d2", "d3", "d4"].map((d) => task(d)),
      30,
    ],
    [
      "duplicate edges count once",
      [
        { taskId: "d1", blockedById: "x" },
        { taskId: "d1", blockedById: "x" },
      ],
      [task("d1")],
      10,
    ],
    ["done dependents do not count", [{ taskId: "d1", blockedById: "x" }], [task("d1", { status: "done" })], 0],
  ])("UNBLOCKS: %s", (_name, edges, others, points) => {
    const { ranked } = rank([task("x"), ...others], { edges });
    const x = ranked.find((c) => c.task.id === "x")!;
    const r = x.reasons.find((r) => r.code === "UNBLOCKS");
    expect(r?.points ?? 0).toBe(points);
    expect(x.score).toBe(points);
  });

  it("estimate is the task's own when set", () => {
    expect(only(task("x", { estimateMin: 90 })).estimateMin).toBe(90);
    expect(only(task("x", { estimateMin: null })).estimateMin).toBe(30);
  });
});

describe("ranking acceptance criteria", () => {
  it.each<Priority>([1, 2, 3, 4])("overdue 3d > due today > due tomorrow at P%i", (p) => {
    const { ranked } = rank([
      task("tomorrow", { deadline: due(1), priority: p }),
      task("today", { deadline: TODAY, priority: p }),
      task("overdue3", { deadline: due(-3), priority: p }),
    ]);
    expect(ids(ranked)).toEqual(["overdue3", "today", "tomorrow"]);
  });

  it.each<Priority>([1, 2, 3, 4])("overdue 30d at P%i (with every bonus) ranks below due-today P1", (p) => {
    const blocks = ["d1", "d2", "d3", "d4"];
    const { ranked } = rank(
      [
        task("stale", { deadline: due(-30), priority: p, seriesId: "s", occurrenceDate: due(-30) }),
        task("today", { deadline: TODAY, priority: 1, estimateMin: 600 }),
        ...blocks.map((d) => task(d, { status: "open" })),
      ],
      {
        edges: blocks.map((d) => ({ taskId: d, blockedById: "stale" })),
        carriedOverIds: ["stale"],
      },
    );
    const order = ids(ranked);
    expect(order.indexOf("today")).toBeLessThan(order.indexOf("stale"));
  });

  it.each<[string, Partial<SchedulerTask>]>([
    ["no deadline", {}],
    ["due in 5d", { deadline: due(5) }],
    ["overdue 3d", { deadline: due(-3), priority: 2 }],
    ["stale", { deadline: due(-40), priority: 1 }],
  ])("carried over adds exactly +%s", (_name, over) => {
    const plain = only(task("x", over));
    const carried = only(task("x", over), { carriedOverIds: ["x"] });
    expect(carried.score - plain.score).toBe(CARRIED_OVER_POINTS);
    expect(CARRIED_OVER_POINTS).toBe(5);
  });

  it("carrying over does not lift a task into the next tier", () => {
    const { ranked } = rank(
      [task("carried", { deadline: due(1) }), task("today", { deadline: TODAY })],
      { carriedOverIds: ["carried"] },
    );
    expect(ids(ranked)).toEqual(["today", "carried"]);
  });
});

describe("deterministic tie-break", () => {
  // Each pair has equal scores; `first` must win on the named key.
  const at = (ms: number) => new Date(T0 + ms);
  it.each<[string, SchedulerTask, SchedulerTask, Partial<CandidateInput>?]>([
    [
      "earlier deadline",
      task("b", { deadline: due(1) }), // DUE_TOMORROW 60
      task("a", { deadline: due(2), priority: 3 }), // DUE_IN 50 + P3 10
    ],
    ["deadline before no deadline", task("b", { deadline: due(10) }), task("a")],
    [
      "higher priority",
      task("b", { priority: 2, estimateMin: 999 }), // P2 25
      task("a", { priority: 3 }), // P3 10 + UNBLOCKS 10 + CARRIED_OVER 5
      { edges: [{ taskId: "dep", blockedById: "a" }], carriedOverIds: ["a"] },
    ],
    ["shorter estimate", task("b", { estimateMin: 15, createdAt: at(5) }), task("a", { estimateMin: 20 })],
    ["assumed estimate counts as its default", task("b", { estimateMin: null }), task("a", { estimateMin: 31 })],
    ["earlier createdAt", task("b", { createdAt: at(0) }), task("a", { createdAt: at(1) })],
    ["smaller id", task("a"), task("b")],
    ["id is code-unit order, not locale", task("B"), task("a")],
  ])("%s", (_name, first, second, over = {}) => {
    const pair = [first.id, second.id];
    for (const tasks of [
      [second, first, task("dep")],
      [first, second, task("dep")],
    ]) {
      const ranked = rank(tasks, over).ranked.filter((c) => pair.includes(c.task.id));
      expect(ranked[0]!.score).toBe(ranked[1]!.score);
      expect(ids(ranked)).toEqual(pair);
    }
  });

  it("same input gives identical output, regardless of input order", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const tasks = Array.from({ length: 300 }, (_, i) =>
      task(`t${String(i).padStart(3, "0")}`, {
        priority: (1 + Math.floor(rnd() * 4)) as Priority,
        deadline: rnd() < 0.6 ? due(Math.floor(rnd() * 10) - 5) : null,
        estimateMin: rnd() < 0.3 ? null : [15, 30, 60][Math.floor(rnd() * 3)]!,
        createdAt: new Date(T0 + Math.floor(rnd() * 3) * 1000),
      }),
    );
    const input: CandidateInput = {
      today: TODAY,
      tasks,
      edges: [{ taskId: "t001", blockedById: "t002" }],
      carriedOverIds: ["t010", "t011"],
    };
    const a = rankCandidates(input);
    const b = rankCandidates(input);
    expect(b).toEqual(a);

    const shuffled = [...tasks].reverse();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    expect(ids(rankCandidates({ ...input, tasks: shuffled }).ranked)).toEqual(ids(a.ranked));
  });
});

describe("input validation", () => {
  it.each([
    ["invalid today", { today: "2026-02-29" }],
    ["zero default estimate", { defaultEstimateMin: 0 }],
    ["NaN default estimate", { defaultEstimateMin: Number.NaN }],
  ])("%s throws RangeError", (_name, over) => {
    expect(() => rank([task("a")], over)).toThrow(RangeError);
  });
});
