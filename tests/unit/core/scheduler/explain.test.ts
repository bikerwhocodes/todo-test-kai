import { describe, expect, it } from "vitest";

import { explainReasons, explainSize, type Reason } from "@/core/scheduler";

// One of each code, with the points the score table would give.
const R = {
  overdue: (days: number): Reason => ({ code: "OVERDUE", days, points: Math.min(100 + 5 * (days - 1), 130) }),
  stale: (days: number): Reason => ({ code: "STALE_OVERDUE", days, points: 40 }),
  dueToday: { code: "DUE_TODAY", points: 80 } as Reason,
  dueTomorrow: { code: "DUE_TOMORROW", points: 60 } as Reason,
  dueIn: (days: number): Reason => ({ code: "DUE_IN", days, points: 50 - 5 * (days - 2) }),
  p1: { code: "PRIORITY", priority: 1, points: 40 } as Reason,
  p2: { code: "PRIORITY", priority: 2, points: 25 } as Reason,
  unblocks: (count: number): Reason => ({ code: "UNBLOCKS", count, points: Math.min(10 * count, 30) }),
  carried: { code: "CARRIED_OVER", points: 5 } as Reason,
  recurring: { code: "RECURRING", points: 0 } as Reason,
  assumed: (minutes: number): Reason => ({ code: "ASSUMED_ESTIMATE", minutes, points: 0 }),
  fits: (remainingMin: number): Reason => ({ code: "FITS_REMAINING", remainingMin, points: 0 }),
};

describe("explainReasons labels", () => {
  it.each<[Reason, string]>([
    [R.overdue(2), "Overdue by 2 days"],
    [R.overdue(1), "Overdue by 1 day"],
    [R.stale(20), "Overdue 20 days"],
    [R.dueToday, "Due today"],
    [R.dueTomorrow, "Due tomorrow"],
    [R.dueIn(3), "Due in 3 days"],
    [R.p1, "Priority 1"],
    [R.unblocks(2), "Unblocks 2 tasks"],
    [R.unblocks(1), "Unblocks 1 task"],
    [R.carried, "From yesterday"],
    [R.recurring, "Recurring"],
    [R.assumed(30), "No estimate: assuming 30m"],
    [R.assumed(90), "No estimate: assuming 1h 30m"],
    [R.fits(20), "Fits your remaining 20m"],
  ])("%j -> %s", (reason, expected) => {
    expect(explainReasons([reason])).toEqual([expected]);
  });
});

describe("explainReasons ranking", () => {
  it("puts the most points first, whatever the input order", () => {
    expect(explainReasons([R.p1, R.carried, R.overdue(2)])).toEqual(["Overdue by 2 days", "Priority 1"]);
    expect(explainReasons([R.carried, R.unblocks(3), R.p2])).toEqual(["Unblocks 3 tasks", "Priority 2"]);
  });

  it("breaks equal points by score-table order", () => {
    // STALE_OVERDUE and P1 are both 40; the deadline row comes first in the table.
    expect(explainReasons([R.p1, R.stale(20)])).toEqual(["Overdue 20 days", "Priority 1"]);
    // DUE_IN 4 days is 40 too, and also ahead of PRIORITY.
    expect(explainReasons([R.p1, R.dueIn(4)])).toEqual(["Due in 4 days", "Priority 1"]);
  });

  it("fills free slots with zero-point reasons only after the point reasons", () => {
    expect(explainReasons([R.recurring, R.assumed(30), R.carried])).toEqual(["From yesterday", "Recurring"]);
    expect(explainReasons([R.fits(20), R.dueToday, R.p1])).toEqual(["Due today", "Priority 1"]);
    expect(explainReasons([R.fits(20), R.assumed(30)])).toEqual(["No estimate: assuming 30m", "Fits your remaining 20m"]);
  });

  it("respects max, and never returns nothing", () => {
    expect(explainReasons([R.dueToday, R.p1, R.unblocks(1)], 3)).toEqual(["Due today", "Priority 1", "Unblocks 1 task"]);
    expect(explainReasons([R.dueToday, R.p1], 1)).toEqual(["Due today"]);
    expect(explainReasons([R.dueToday, R.p1], 0)).toEqual(["Due today"]);
    expect(explainReasons([])).toEqual(["Fits your time"]);
  });

  it("returns 1..max labels for every combination of reasons", () => {
    const pool: Reason[] = [
      R.overdue(3),
      R.stale(30),
      R.dueToday,
      R.dueTomorrow,
      R.dueIn(5),
      R.p1,
      R.unblocks(2),
      R.carried,
      R.recurring,
      R.assumed(30),
      R.fits(15),
    ];
    // Every subset of the pool (2^11), each against max 1..3.
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const reasons = pool.filter((_, i) => mask & (1 << i));
      for (const max of [1, 2, 3]) {
        const labels = explainReasons(reasons, max);
        expect(labels.length).toBeGreaterThanOrEqual(1);
        expect(labels.length).toBeLessThanOrEqual(max);
        expect(labels.length).toBe(Math.max(1, Math.min(max, reasons.length)));
        expect(labels.every((l) => l.length > 0)).toBe(true);
      }
    }
  });
});

describe("explainSize", () => {
  it("says how much more a too-large task needs", () => {
    expect(explainSize({ code: "TOO_LARGE", needMin: 180, availableMin: 120 })).toBe("Needs 3h, more than your 2h");
    expect(explainSize({ code: "TOO_LARGE", needMin: 90, availableMin: 0 })).toBe("Needs 1h 30m, more than your 0m");
  });

  it("says how little time is left", () => {
    expect(explainSize({ code: "NO_ROOM_LEFT", needMin: 45, remainingMin: 20 })).toBe("Needs 45m; 20m left");
  });
});
