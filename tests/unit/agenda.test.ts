import { describe, expect, it } from "vitest";
import {
  UPCOMING_DAYS,
  dueNotInPlan,
  formatDayHeading,
  formatOverdue,
  formatShortDate,
  groupUpcoming,
  upcomingEnd,
  type AgendaTask,
} from "@/core/agenda";
import { addDays, localToday } from "@/core/dates";

type T = AgendaTask;

const task = (id: string, deadline: string | null, status = "open"): T => ({ id, deadline, status });
const ids = (list: { id: string }[]) => list.map((t) => t.id);
/** groupUpcoming as [label, ids] pairs, overdue first. */
const shape = (tasks: T[], today: string, days?: number) => {
  const { overdue, days: groups } = groupUpcoming(tasks, today, days);
  return [
    ...(overdue.length > 0 ? [["overdue", ids(overdue)] as const] : []),
    ...groups.map((g) => [g.date, ids(g.tasks)] as const),
  ];
};

describe("the user's zone decides what today is", () => {
  // 2026-11-01T06:30Z is 23:30 on Oct 31 in Los Angeles and 15:30 on Nov 1 in Tokyo.
  const now = new Date("2026-11-01T06:30:00Z");
  const tasks = [task("oct31", "2026-10-31"), task("nov1", "2026-11-01"), task("nov14", "2026-11-14")];

  it.each([
    {
      tz: "America/Los_Angeles",
      today: "2026-10-31",
      upcoming: [
        ["2026-10-31", ["oct31"]],
        ["2026-11-01", ["nov1"]],
      ],
      due: ["oct31"],
    },
    {
      tz: "Asia/Tokyo",
      today: "2026-11-01",
      upcoming: [
        ["overdue", ["oct31"]],
        ["2026-11-01", ["nov1"]],
        ["2026-11-14", ["nov14"]],
      ],
      due: ["oct31", "nov1"],
    },
  ])("$tz", ({ tz, today, upcoming, due }) => {
    expect(localToday(tz, now)).toBe(today);
    expect(shape(tasks, localToday(tz, now))).toEqual(upcoming);
    expect(ids(dueNotInPlan(tasks, localToday(tz, now), []))).toEqual(due);
  });
});

describe("groupUpcoming", () => {
  const today = "2026-10-22";

  it.each([
    { name: "yesterday is overdue", deadline: "2026-10-21", group: "overdue" },
    { name: "long overdue is still overdue", deadline: "2025-01-01", group: "overdue" },
    { name: "exactly today is not overdue", deadline: "2026-10-22", group: "2026-10-22" },
    { name: "day 13 (today + 13) is included", deadline: "2026-11-04", group: "2026-11-04" },
    { name: "day 14 (today + 14) is excluded", deadline: "2026-11-05", group: null },
    { name: "a year out is excluded", deadline: "2027-10-22", group: null },
    { name: "no deadline is excluded", deadline: null, group: null },
  ])("$name", ({ deadline, group }) => {
    const result = shape([task("t", deadline)], today);
    expect(result).toEqual(group === null ? [] : [[group, ["t"]]]);
  });

  it.each(["done", "skipped"])("leaves out %s tasks, overdue or not", (status) => {
    const tasks = [task("a", "2026-10-01", status), task("b", "2026-10-22", status), task("c", "2026-10-25", status)];
    expect(shape(tasks, today)).toEqual([]);
  });

  it("orders overdue oldest first, then one group per date in date order, only for dates with tasks", () => {
    const tasks = [
      task("d30", "2026-10-30"),
      task("late2", "2026-10-20"),
      task("d22a", "2026-10-22"),
      task("late1", "2026-09-01"),
      task("d24", "2026-10-24"),
      task("d22b", "2026-10-22"),
      task("none", null),
    ];
    expect(shape(tasks, today)).toEqual([
      ["overdue", ["late1", "late2"]],
      ["2026-10-22", ["d22a", "d22b"]], // same date keeps input order
      ["2026-10-24", ["d24"]],
      ["2026-10-30", ["d30"]],
    ]);
  });

  it("covers 14 days by default and accepts another window", () => {
    expect(UPCOMING_DAYS).toBe(14);
    expect(upcomingEnd(today)).toBe("2026-11-04");
    const daily = Array.from({ length: 20 }, (_, i) => task(`d${i}`, addDays(today, i)));
    expect(groupUpcoming(daily, today).days.map((g) => g.date)).toEqual(
      Array.from({ length: 14 }, (_, i) => addDays(today, i)),
    );
    expect(shape(daily, today, 1)).toEqual([[today, ["d0"]]]);
    expect(() => upcomingEnd(today, 0)).toThrow(RangeError);
  });

  it("spans month and year ends by calendar date", () => {
    expect(shape([task("a", "2027-01-02"), task("b", "2027-01-03")], "2026-12-21")).toEqual([
      ["2027-01-02", ["a"]],
      ["2027-01-03", ["b"]],
    ]);
    expect(upcomingEnd("2026-12-21")).toBe("2027-01-03");
    expect(upcomingEnd("2028-02-20")).toBe("2028-03-04"); // leap year
  });

  it("does not mutate its input", () => {
    const tasks = [task("b", "2026-10-25"), task("a", "2026-10-23")];
    groupUpcoming(tasks, today);
    expect(ids(tasks)).toEqual(["b", "a"]);
  });
});

describe("dueNotInPlan", () => {
  const today = "2026-10-22";
  const tasks = [
    task("today1", "2026-10-22"),
    task("tomorrow", "2026-10-23"),
    task("old", "2026-09-30"),
    task("yesterday", "2026-10-21"),
    task("today2", "2026-10-22"),
    task("none", null),
    task("doneOverdue", "2026-10-01", "done"),
    task("skippedToday", "2026-10-22", "skipped"),
  ];

  it.each([
    { name: "with no plan: overdue oldest first, then due today", planned: [], want: ["old", "yesterday", "today1", "today2"] },
    { name: "leaves out a planned overdue task", planned: ["yesterday"], want: ["old", "today1", "today2"] },
    { name: "leaves out a planned task due today", planned: ["today2"], want: ["old", "yesterday", "today1"] },
    { name: "is empty when everything due is planned", planned: ["old", "yesterday", "today1", "today2"], want: [] },
    { name: "ignores planned ids that aren't due", planned: ["tomorrow", "none", "unknown"], want: ["old", "yesterday", "today1", "today2"] },
  ])("$name", ({ planned, want }) => {
    expect(ids(dueNotInPlan(tasks, today, planned))).toEqual(want);
    expect(ids(dueNotInPlan(tasks, today, new Set(planned)))).toEqual(want);
  });
});

describe("labels", () => {
  it.each([
    // date, today, heading
    ["2026-10-22", "2026-10-22", "Today · Thu 22 Oct"],
    ["2026-10-23", "2026-10-22", "Tomorrow · Fri 23 Oct"],
    ["2026-10-24", "2026-10-22", "Sat 24 Oct"],
    ["2026-11-01", "2026-10-31", "Tomorrow · Sun 1 Nov"], // month boundary
    ["2026-12-31", "2026-12-31", "Today · Thu 31 Dec"],
    ["2027-01-01", "2026-12-31", "Tomorrow · Fri 1 Jan 2027"], // year boundary adds the year
    ["2027-01-03", "2026-12-25", "Sun 3 Jan 2027"],
    ["2028-02-29", "2028-02-20", "Tue 29 Feb"], // leap day
    ["2026-03-29", "2026-03-28", "Tomorrow · Sun 29 Mar"], // EU DST change
    ["2026-11-01", "2026-11-01", "Today · Sun 1 Nov"], // US DST change
  ])("%s seen on %s is %s", (date, today, heading) => {
    expect(formatDayHeading(date, today)).toBe(heading);
  });

  it("formats short dates from the string alone", () => {
    expect(formatShortDate("2026-10-05", "2026-10-22")).toBe("Mon 5 Oct");
    expect(formatShortDate("2025-12-31", "2026-01-01")).toBe("Wed 31 Dec 2025");
    expect(() => formatShortDate("2026-02-30", "2026-01-01")).toThrow(RangeError);
  });

  it.each([
    ["2026-10-22", "2026-10-22", null],
    ["2026-10-23", "2026-10-22", null],
    ["2026-10-21", "2026-10-22", "1 day overdue"],
    ["2026-10-01", "2026-10-22", "21 days overdue"],
    ["2026-12-31", "2027-01-02", "2 days overdue"],
    ["2026-10-31", "2026-11-02", "2 days overdue"], // across a DST change
  ])("deadline %s on %s: %s", (deadline, today, text) => {
    expect(formatOverdue(deadline, today)).toBe(text);
  });
});
