import { describe, expect, it } from "vitest";
import {
  FALLBACK_REASON,
  acceptLabel,
  acceptPayload,
  defaultSplitMin,
  dropIndex,
  filterSearch,
  findRow,
  formatNothingFits,
  formatOver,
  formatPlannedOf,
  initialPanelState,
  manualRow,
  moveAnnouncement,
  moveItem,
  moveTo,
  nothingToPlanReasons,
  panelReducer,
  parseDuration,
  planTotals,
  readDuration,
  reasonChips,
  rowIds,
  splitTitle,
  suggestionRow,
  type PanelState,
  type PlanRow,
} from "@/components/plan/model";
import { TITLE_MAX } from "@/lib/limits";

const row = (taskId: string, patch: Partial<PlanRow> = {}): PlanRow => ({
  taskId,
  title: taskId.toUpperCase(),
  estimateMin: 30,
  done: false,
  kind: "suggested",
  reasons: ["Due today"],
  ...patch,
});

describe("parseDuration", () => {
  it.each([
    ["90", 90],
    ["90m", 90],
    ["90 m", 90],
    ["90 min", 90],
    ["90 mins", 90],
    ["45 minutes", 45],
    ["1h", 60],
    ["1 h", 60],
    ["2hr", 120],
    ["2 hours", 120],
    ["1h 30m", 90],
    ["1h30m", 90],
    ["1 h 30 min", 90],
    ["1.5h", 90],
    ["0.25h", 15],
    ["1.5h 15m", 105],
    ["  1H 30M  ", 90],
    ["0", 0],
  ])("reads %j as %i minutes", (input, minutes) => {
    expect(parseDuration(input)).toBe(minutes);
  });

  it.each(["", "   ", "abc", "1.5", "-30", "h", "m", "1h 30", "30m 1h", "1,5h", ".5h", "1h 1.5m", "90s"])(
    "rejects %j",
    (input) => {
      expect(parseDuration(input)).toBeNull();
    },
  );
});

describe("readDuration", () => {
  it("accepts 1..1440 minutes", () => {
    expect(readDuration("1")).toEqual({ ok: true, minutes: 1 });
    expect(readDuration("24h")).toEqual({ ok: true, minutes: 1440 });
  });

  it("refuses 0, more than 24 hours and junk with a message", () => {
    expect(readDuration("0")).toMatchObject({ ok: false, error: expect.stringMatching(/at least 1/) });
    expect(readDuration("1441")).toMatchObject({ ok: false, error: expect.stringMatching(/24h/) });
    expect(readDuration("24h 1m")).toMatchObject({ ok: false });
    expect(readDuration("soon")).toMatchObject({ ok: false, error: expect.stringMatching(/1h 30m/) });
  });

  it("treats empty as an error, or as clearing when allowed", () => {
    expect(readDuration("  ")).toMatchObject({ ok: false });
    expect(readDuration("  ", { allowEmpty: true })).toEqual({ ok: true, minutes: null });
  });
});

describe("planTotals", () => {
  it("counts open rows at their estimate, or the default when they have none", () => {
    const items = [row("a", { estimateMin: 45 }), row("b", { estimateMin: null }), row("c", { estimateMin: 15 })];
    expect(planTotals(items, 120, 30)).toEqual({ plannedMin: 90, availableMin: 120, overMin: 0, remainingMin: 30 });
  });

  it("leaves done rows out, whatever their estimate", () => {
    const items = [row("a", { estimateMin: 60, done: true }), row("b", { estimateMin: null, done: true }), row("c")];
    expect(planTotals(items, 60, 30).plannedMin).toBe(30);
  });

  it("is not over when the plan exactly fills the time, and over by 1 minute past it", () => {
    expect(planTotals([row("a", { estimateMin: 120 })], 120, 30)).toMatchObject({ overMin: 0, remainingMin: 0 });
    expect(planTotals([row("a", { estimateMin: 121 })], 120, 30)).toMatchObject({ overMin: 1, remainingMin: 0 });
  });

  it("is empty with no rows", () => {
    expect(planTotals([], 60, 30)).toEqual({ plannedMin: 0, availableMin: 60, overMin: 0, remainingMin: 60 });
  });
});

describe("formatting", () => {
  it("formatPlannedOf", () => {
    expect(formatPlannedOf(105, 120)).toBe("1h 45m planned of 2h");
    expect(formatPlannedOf(0, 90)).toBe("0m planned of 1h 30m");
  });

  it("formatOver is always minutes", () => {
    expect(formatOver(25)).toBe("25 min over");
    expect(formatOver(90)).toBe("90 min over");
  });

  it("formatNothingFits lists the shortest tasks", () => {
    expect(formatNothingFits(30, [45, 60])).toBe("Nothing fits in 30m. Your shortest tasks need 45m, 1h.");
    expect(formatNothingFits(30, [45])).toBe("Nothing fits in 30m. Your shortest task needs 45m.");
    expect(formatNothingFits(30, [45, 60, 90, 120])).toBe(
      "Nothing fits in 30m. Your shortest tasks need 45m, 1h, 1h 30m…",
    );
    expect(formatNothingFits(30, [])).toBe("Nothing fits in 30m.");
  });

  it("moveAnnouncement is 1-based", () => {
    expect(moveAnnouncement("Write report", 1, 5)).toBe("Moved Write report to position 2 of 5");
  });

  it("acceptLabel", () => {
    expect(acceptLabel(0)).toBe("Done");
    expect(acceptLabel(3)).toBe("Add 3 to plan");
  });
});

describe("nothingToPlanReasons", () => {
  it("says why, with counts", () => {
    const excluded = [
      { id: "1", reason: "blocked" },
      { id: "2", reason: "blocked" },
      { id: "3", reason: "dismissed" },
      { id: "4", reason: "future_occurrence" },
      { id: "5", reason: "future_occurrence" },
    ];
    expect(nothingToPlanReasons(excluded, 3)).toEqual([
      "3 tasks are blocked",
      "1 task was set aside for today",
      "2 repeating tasks aren't due yet",
    ]);
    expect(nothingToPlanReasons([{ reason: "blocked" }], 0)).toEqual(["1 task is blocked"]);
  });

  it("falls back to no open tasks", () => {
    expect(nothingToPlanReasons([], 0)).toEqual(["You have no open tasks"]);
  });
});

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"];

  it("moves up and down by one", () => {
    expect(moveItem(list, 1, -1)).toEqual(["b", "a", "c", "d"]);
    expect(moveItem(list, 1, 1)).toEqual(["a", "c", "b", "d"]);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("moves to the ends", () => {
    expect(moveItem(list, 2, 1)).toEqual(["a", "b", "d", "c"]);
    expect(moveItem(list, 1, -1)[0]).toBe("b");
  });

  it("returns the same list when the move would go past either end", () => {
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 3, 1)).toBe(list);
    expect(moveItem(list, 0, 0)).toBe(list);
    expect(moveItem([], 0, 1)).toEqual([]);
  });

  it("moveTo moves across several places and ignores bad indexes", () => {
    expect(moveTo(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveTo(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTo(list, -1, 0)).toBe(list);
    expect(moveTo(list, 0, 4)).toBe(list);
  });

  it("dropIndex turns 'drop before row i' into a target index", () => {
    // Dragging row 1 of 4.
    expect(dropIndex(1, 0)).toBe(0);
    expect(dropIndex(1, 1)).toBe(1);
    expect(dropIndex(1, 2)).toBe(1);
    expect(dropIndex(1, 3)).toBe(2);
    expect(dropIndex(1, 4)).toBe(3);
    expect(moveTo(list, 1, dropIndex(1, 4))).toEqual(["a", "c", "d", "b"]);
  });
});

describe("filterSearch", () => {
  const options = [
    { id: "1", title: "Write report" },
    { id: "2", title: "Read REPORT draft" },
    { id: "3", title: "Call the bank" },
    { id: "4", title: "Report expenses" },
  ];

  it("matches a case-insensitive substring, in order", () => {
    expect(filterSearch(options, "report", []).map((o) => o.id)).toEqual(["1", "2", "4"]);
    expect(filterSearch(options, "  BANK ", []).map((o) => o.id)).toEqual(["3"]);
  });

  it("leaves out excluded ids (already in the list, or blocked)", () => {
    expect(filterSearch(options, "report", new Set(["1", "4"])).map((o) => o.id)).toEqual(["2"]);
  });

  it("matches nothing for an empty query", () => {
    expect(filterSearch(options, "", [])).toEqual([]);
    expect(filterSearch(options, "   ", [])).toEqual([]);
  });

  it("shows at most 8 by default", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `Task ${i}` }));
    expect(filterSearch(many, "task", [])).toHaveLength(8);
    expect(filterSearch(many, "task", ["0", "1"])[0]!.id).toBe("2");
  });
});

describe("rows and payloads", () => {
  it("reasonChips keeps 1–2 labels and is never empty", () => {
    expect(reasonChips(["A", "B", "C"])).toEqual(["A", "B"]);
    expect(reasonChips([])).toEqual([FALLBACK_REASON]);
    expect(reasonChips([" "])).toEqual([FALLBACK_REASON]);
    expect(suggestionRow({ id: "x", title: "X", estimateMin: null, reasons: [] }).reasons).toEqual([FALLBACK_REASON]);
  });

  it("splitTitle appends (part 1) and stays a valid title", () => {
    expect(splitTitle("Paint the room")).toBe("Paint the room (part 1)");
    const long = splitTitle("x".repeat(TITLE_MAX));
    expect(long.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(long.endsWith("… (part 1)")).toBe(true);
  });

  it("defaultSplitMin is the time left, else 30", () => {
    expect(defaultSplitMin(25)).toBe(25);
    expect(defaultSplitMin(0)).toBe(30);
  });

  it("acceptPayload sends the draft in order and marks hand-added ids", () => {
    const draft = [row("a"), row("b", { kind: "manual" }), row("c")];
    expect(acceptPayload(draft, 120)).toEqual({ taskIds: ["a", "b", "c"], availableMin: 120, manualTaskIds: ["b"] });
    expect(acceptPayload([], 60)).toEqual({ taskIds: [], availableMin: 60, manualTaskIds: [] });
  });
});

describe("panelReducer", () => {
  const start = (): PanelState => ({
    ...initialPanelState([
      { taskId: "s1", title: "S1", estimateMin: 30, done: false },
      { taskId: "s2", title: "S2", estimateMin: null, done: true },
    ]),
    draft: [row("d1"), row("m1", { kind: "manual", reasons: [] })],
  });

  it("starts with the saved plan and an empty draft", () => {
    const state = initialPanelState([{ taskId: "s1", title: "S1", estimateMin: 30, done: false }]);
    expect(state.draft).toEqual([]);
    expect(state.saved[0]).toMatchObject({ taskId: "s1", kind: "saved", done: false });
  });

  it("setDraft replaces suggestions, keeps hand-added rows after them and skips planned tasks", () => {
    const next = panelReducer(start(), { type: "setDraft", suggestions: [row("d2"), row("s1"), row("m1")] });
    expect(next.draft.map((r) => [r.taskId, r.kind])).toEqual([
      ["d2", "suggested"],
      ["m1", "manual"],
    ]);
  });

  it("remove and restore put a row back where it was", () => {
    const state = start();
    const found = findRow(state, "s1")!;
    const removed = panelReducer(state, { type: "remove", taskId: "s1" });
    expect(removed.saved.map((r) => r.taskId)).toEqual(["s2"]);
    const restored = panelReducer(removed, { type: "restore", ...found });
    expect(restored.saved.map((r) => r.taskId)).toEqual(["s1", "s2"]);
    // Restoring a row that is already there does nothing.
    expect(panelReducer(restored, { type: "restore", ...found })).toBe(restored);
  });

  it("moves within one segment only", () => {
    const state = start();
    const moved = panelReducer(state, { type: "move", segment: "draft", index: 0, delta: 1 });
    expect(moved.draft.map((r) => r.taskId)).toEqual(["m1", "d1"]);
    expect(moved.saved).toBe(state.saved);
    expect(panelReducer(state, { type: "move", segment: "saved", index: 1, delta: 1 })).toBe(state);
    expect(panelReducer(state, { type: "moveTo", segment: "saved", from: 1, to: 0 }).saved[0]!.taskId).toBe("s2");
  });

  it("addManual appends once, as manual, and never duplicates a row in either segment", () => {
    const state = start();
    const added = panelReducer(state, { type: "addManual", row: manualRow({ id: "n1", title: "N1", estimateMin: 90 }) });
    expect(added.draft.at(-1)).toMatchObject({ taskId: "n1", kind: "manual", reasons: [] });
    expect(panelReducer(added, { type: "addManual", row: manualRow({ id: "n1", title: "N1", estimateMin: 90 }) })).toBe(added);
    expect(panelReducer(state, { type: "addManual", row: manualRow({ id: "s1", title: "S1", estimateMin: 1 }) })).toBe(state);
    expect(rowIds(added)).toEqual(new Set(["s1", "s2", "d1", "m1", "n1"]));
  });

  it("setEstimate updates the row and so the totals", () => {
    const state = panelReducer(start(), { type: "setEstimate", taskId: "d1", estimateMin: 90 });
    expect(findRow(state, "d1")!.row.estimateMin).toBe(90);
    // s1 30 + d1 90 + m1 30; s2 is done.
    expect(planTotals([...state.saved, ...state.draft], 120, 30)).toMatchObject({ plannedMin: 150, overMin: 30 });
    const cleared = panelReducer(state, { type: "setEstimate", taskId: "s1", estimateMin: null });
    expect(findRow(cleared, "s1")!.row.estimateMin).toBeNull();
  });
});
