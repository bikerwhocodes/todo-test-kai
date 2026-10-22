import { describe, expect, it } from "vitest";
import { type IsoDate, type Weekday, addDays, compareIsoDate, diffDays, maxIsoDate, weekdayOf } from "@/core/dates";
import {
  type RecurrenceRule,
  MISSED_CAP,
  firstOccurrence,
  missedLabel,
  missedOccurrences,
  nextOccurrence,
  nextOccurrenceAfterCompletion,
  occurrenceOnOrAfterDate,
  occurrencesBetween,
  validateRule,
} from "@/core/recurrence";

const daily = (interval: number, startDate: IsoDate, endDate?: IsoDate): RecurrenceRule =>
  endDate === undefined ? { kind: "daily", interval, startDate } : { kind: "daily", interval, startDate, endDate };

const weekly = (
  interval: number,
  weekdays: Weekday[],
  startDate: IsoDate,
  endDate?: IsoDate,
): RecurrenceRule =>
  endDate === undefined
    ? { kind: "weekly", interval, weekdays, startDate }
    : { kind: "weekly", interval, weekdays, startDate, endDate };

// 2026-10-19 is a Monday.
const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6, SUN = 0;

describe("firstOccurrence", () => {
  it.each<[string, RecurrenceRule, IsoDate | null]>([
    ["daily starts on startDate", daily(1, "2026-10-22"), "2026-10-22"],
    ["every 3 days starts on startDate", daily(3, "2026-10-22"), "2026-10-22"],
    ["weekly, startDate is a selected day", weekly(1, [THU], "2026-10-22"), "2026-10-22"],
    ["weekly, next selected day later this week", weekly(1, [SAT], "2026-10-22"), "2026-10-24"],
    ["weekly, Sunday is end of the ISO week", weekly(2, [SUN], "2026-10-22"), "2026-10-25"],
    ["weekly, only earlier weekday → next week", weekly(1, [MON], "2026-10-22"), "2026-10-26"],
    ["every 2 weeks, earlier weekday → skips to week 2", weekly(2, [MON], "2026-10-22"), "2026-11-02"],
    ["ends before first match", weekly(1, [MON], "2026-10-22", "2026-10-25"), null],
    ["endDate == startDate", daily(1, "2026-10-22", "2026-10-22"), "2026-10-22"],
  ])("%s", (_, rule, expected) => {
    expect(firstOccurrence(rule)).toBe(expected);
  });
});

describe("nextOccurrence — daily", () => {
  it.each<[string, RecurrenceRule, IsoDate, IsoDate | null]>([
    ["every day", daily(1, "2026-10-01"), "2026-10-22", "2026-10-23"],
    ["before start → start", daily(1, "2026-10-22"), "2026-10-01", "2026-10-22"],
    ["day before start → start", daily(5, "2026-10-22"), "2026-10-21", "2026-10-22"],
    ["every 3 days on schedule", daily(3, "2026-10-01"), "2026-10-04", "2026-10-07"],
    ["every 3 days off schedule stays on grid", daily(3, "2026-10-01"), "2026-10-05", "2026-10-07"],
    ["month boundary", daily(1, "2026-01-01"), "2026-01-31", "2026-02-01"],
    ["year boundary", daily(1, "2026-01-01"), "2026-12-31", "2027-01-01"],
    ["into leap day", daily(1, "2028-01-01"), "2028-02-28", "2028-02-29"],
    ["out of leap day", daily(1, "2028-01-01"), "2028-02-29", "2028-03-01"],
    ["non-leap Feb", daily(1, "2027-01-01"), "2027-02-28", "2027-03-01"],
    ["every 2 days across Feb 2028", daily(2, "2028-02-27"), "2028-02-27", "2028-02-29"],
    ["every 2 days across Feb 2027", daily(2, "2027-02-27"), "2027-02-27", "2027-03-01"],
    ["EU DST day", daily(1, "2026-10-01"), "2026-10-24", "2026-10-25"],
    ["after EU DST day", daily(1, "2026-10-01"), "2026-10-25", "2026-10-26"],
    ["US DST day", daily(1, "2026-10-01"), "2026-10-31", "2026-11-01"],
    ["after US DST day", daily(1, "2026-10-01"), "2026-11-01", "2026-11-02"],
    ["last allowed date", daily(1, "2026-10-01", "2026-10-31"), "2026-10-30", "2026-10-31"],
    ["past endDate → null", daily(1, "2026-10-01", "2026-10-31"), "2026-10-31", null],
    ["next grid date past endDate → null", daily(7, "2026-10-01", "2026-10-14"), "2026-10-08", null],
    ["interval 365 across leap year", daily(365, "2027-03-01"), "2027-03-01", "2028-02-29"],
  ])("%s", (_, rule, after, expected) => {
    expect(nextOccurrence(rule, after)).toBe(expected);
  });
});

describe("nextOccurrence — weekly", () => {
  it.each<[string, RecurrenceRule, IsoDate, IsoDate | null]>([
    ["Mon/Wed/Fri, Thu → Fri", weekly(1, [MON, WED, FRI], "2026-10-19"), "2026-10-22", "2026-10-23"],
    ["Mon/Wed/Fri, Fri → next Mon", weekly(1, [MON, WED, FRI], "2026-10-19"), "2026-10-23", "2026-10-26"],
    ["weekday order is irrelevant", weekly(1, [FRI, MON, WED], "2026-10-19"), "2026-10-23", "2026-10-26"],
    ["duplicates are harmless", weekly(1, [WED, WED], "2026-10-19"), "2026-10-21", "2026-10-28"],
    ["Sunday in active week", weekly(2, [SAT, SUN], "2026-10-19"), "2026-10-24", "2026-10-25"],
    ["every 2 weeks skips the off week", weekly(2, [MON, FRI], "2026-10-19"), "2026-10-23", "2026-11-02"],
    ["every 2 weeks, from an off week", weekly(2, [TUE], "2026-10-19"), "2026-10-28", "2026-11-03"],
    ["every 3 weeks", weekly(3, [WED], "2026-10-21"), "2026-10-21", "2026-11-11"],
    ["week grid anchored on start week, not start day", weekly(2, [MON], "2026-10-25"), "2026-10-25", "2026-11-02"],
    ["before start", weekly(1, [THU], "2026-10-22"), "2026-01-01", "2026-10-22"],
    ["before start, earlier weekday ignored", weekly(1, [MON, THU], "2026-10-22"), "2026-10-20", "2026-10-22"],
    ["year boundary", weekly(1, [FRI], "2026-12-01"), "2026-12-25", "2027-01-01"],
    ["leap day is a Tuesday", weekly(1, [TUE], "2028-02-01"), "2028-02-22", "2028-02-29"],
    ["across EU DST", weekly(1, [SUN], "2026-10-01"), "2026-10-18", "2026-10-25"],
    ["across US DST", weekly(1, [SUN], "2026-10-01"), "2026-10-25", "2026-11-01"],
    ["endDate inclusive", weekly(1, [FRI], "2026-10-01", "2026-10-30"), "2026-10-23", "2026-10-30"],
    ["past endDate → null", weekly(1, [FRI], "2026-10-01", "2026-10-29"), "2026-10-23", null],
    ["every 52 weeks", weekly(52, [MON], "2026-10-19"), "2026-10-19", "2027-10-18"],
  ])("%s", (_, rule, after, expected) => {
    expect(nextOccurrence(rule, after)).toBe(expected);
  });
});

describe("nextOccurrenceAfterCompletion — next date > max(occurrenceDate, today)", () => {
  it.each<[string, RecurrenceRule, IsoDate, IsoDate, IsoDate | null]>([
    ["on time", daily(1, "2026-10-01"), "2026-10-22", "2026-10-22", "2026-10-23"],
    ["completed early", daily(1, "2026-10-01"), "2026-10-25", "2026-10-22", "2026-10-26"],
    ["overdue: no back-fill", daily(1, "2026-10-01"), "2026-10-10", "2026-10-22", "2026-10-23"],
    ["overdue, every 7 days stays on grid", daily(7, "2026-10-01"), "2026-10-08", "2026-10-22", "2026-10-29"],
    ["overdue weekly", weekly(1, [MON], "2026-10-05"), "2026-10-05", "2026-10-22", "2026-10-26"],
    ["overdue past endDate", daily(1, "2026-10-01", "2026-10-20"), "2026-10-15", "2026-10-22", null],
  ])("%s", (_, rule, occurrence, today, expected) => {
    expect(nextOccurrenceAfterCompletion(rule, occurrence, today)).toBe(expected);
  });

  it("property: result is a series date strictly after max(occurrence, today)", () => {
    const rules: RecurrenceRule[] = [
      daily(1, "2026-01-01"),
      daily(4, "2026-02-27"),
      weekly(1, [MON, THU], "2026-01-01"),
      weekly(3, [SAT, SUN], "2026-02-25"),
    ];
    for (const rule of rules) {
      const series = new Set(occurrencesBetween(rule, "2026-01-01", "2029-12-31", 5000));
      for (let i = 0; i < 400; i += 7) {
        const occurrence = addDays("2026-01-01", i);
        for (const lag of [-3, 0, 1, 40]) {
          const today = addDays(occurrence, lag);
          const next = nextOccurrenceAfterCompletion(rule, occurrence, today)!;
          expect(compareIsoDate(next, maxIsoDate(occurrence, today))).toBe(1);
          expect(series.has(next)).toBe(true);
        }
      }
    }
  });
});

describe("DST: no skipped or duplicate daily dates", () => {
  it.each(["2026-10-25", "2026-11-01", "2026-03-29", "2026-03-08"])("daily series through %s", (dstDay) => {
    const from = addDays(dstDay, -5);
    const rule = daily(1, from);
    const walked: IsoDate[] = [];
    let d: IsoDate | null = firstOccurrence(rule);
    while (d !== null && compareIsoDate(d, addDays(dstDay, 5)) <= 0) {
      walked.push(d);
      d = nextOccurrence(rule, d);
    }
    expect(walked).toHaveLength(11);
    expect(walked).toContain(dstDay);
    expect(new Set(walked).size).toBe(walked.length);
    walked.slice(1).forEach((x, i) => expect(diffDays(walked[i]!, x)).toBe(1));
  });
});

describe("occurrencesBetween", () => {
  it("weekly every 2 weeks Mon/Thu", () => {
    expect(occurrencesBetween(weekly(2, [MON, THU], "2026-10-22"), "2026-10-01", "2026-11-30")).toEqual([
      "2026-10-22",
      "2026-11-02",
      "2026-11-05",
      "2026-11-16",
      "2026-11-19",
      "2026-11-30",
    ]);
  });

  it("respects endDate and limit", () => {
    expect(occurrencesBetween(daily(1, "2026-10-01", "2026-10-03"), "2026-09-01", "2026-12-31")).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(occurrencesBetween(daily(1, "2026-10-01"), "2026-10-01", "2026-12-31", 2)).toHaveLength(2);
  });

  it("weekly occurrences fall only on selected weekdays", () => {
    for (const d of occurrencesBetween(weekly(1, [TUE, SAT], "2026-01-01"), "2026-01-01", "2026-12-31")) {
      expect([TUE, SAT]).toContain(weekdayOf(d));
    }
  });
});

describe("validateRule", () => {
  it.each<[string, RecurrenceRule, boolean]>([
    ["valid daily", daily(1, "2026-10-22"), true],
    ["valid weekly", weekly(1, [MON], "2026-10-22", "2026-12-31"), true],
    ["null endDate", { kind: "daily", interval: 1, startDate: "2026-10-22", endDate: null }, true],
    ["interval 0", daily(0, "2026-10-22"), false],
    ["fractional interval", daily(1.5, "2026-10-22"), false],
    ["interval too large", daily(366, "2026-10-22"), false],
    ["bad startDate", daily(1, "2026-02-30"), false],
    ["endDate before startDate", daily(1, "2026-10-22", "2026-10-21"), false],
    ["no weekdays", weekly(1, [], "2026-10-22"), false],
    ["weekday 7", weekly(1, [7 as never], "2026-10-22"), false],
  ])("%s", (_, rule, ok) => {
    expect(validateRule(rule).length === 0).toBe(ok);
    if (!ok) {
      expect(() => firstOccurrence(rule)).toThrow(RangeError);
      expect(() => nextOccurrence(rule, "2026-10-22")).toThrow(RangeError);
    }
  });

  it("rejects an invalid `after`", () => {
    expect(() => nextOccurrence(daily(1, "2026-10-22"), "2026-13-01")).toThrow(RangeError);
  });
});

describe("performance", () => {
  it("10k nextOccurrence calls on sparse weekly rules < 50 ms", () => {
    const rule = weekly(52, [SUN], "2026-10-19");
    const t0 = performance.now();
    let d: IsoDate = "2026-10-19";
    for (let i = 0; i < 10_000; i++) {
      d = nextOccurrence(rule, addDays("2026-10-19", i % 3000))!;
    }
    expect(d).toBeTruthy();
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("occurrenceOnOrAfterDate", () => {
  const weekly: RecurrenceRule = { kind: "weekly", interval: 1, weekdays: [1, 3], startDate: "2026-10-19" };

  it("returns the date itself when it matches", () => {
    expect(occurrenceOnOrAfterDate(weekly, "2026-10-21")).toBe("2026-10-21");
  });
  it("rolls forward to the next matching weekday", () => {
    expect(occurrenceOnOrAfterDate(weekly, "2026-10-22")).toBe("2026-10-26");
  });
  it("never returns a date before startDate", () => {
    expect(occurrenceOnOrAfterDate({ kind: "daily", interval: 1, startDate: "2026-11-01" }, "2026-10-01")).toBe(
      "2026-11-01",
    );
  });
  it("is null once the series has ended", () => {
    expect(
      occurrenceOnOrAfterDate({ kind: "daily", interval: 1, startDate: "2026-10-01", endDate: "2026-10-10" }, "2026-10-11"),
    ).toBeNull();
  });
});

describe("missedOccurrences / missedLabel", () => {
  const daily: RecurrenceRule = { kind: "daily", interval: 1, startDate: "2026-10-01" };

  it("is 0 when the occurrence is due today or later", () => {
    expect(missedOccurrences(daily, "2026-10-22", "2026-10-22")).toBe(0);
    expect(missedOccurrences(daily, "2026-10-23", "2026-10-22")).toBe(0);
  });
  it("counts 5 after five days away from a daily series", () => {
    expect(missedOccurrences(daily, "2026-10-17", "2026-10-22")).toBe(5);
    expect(missedLabel("daily", 5)).toBe("Missed 5 days");
  });
  it("counts only scheduled dates for weekly rules", () => {
    const weekly: RecurrenceRule = { kind: "weekly", interval: 1, weekdays: [1], startDate: "2026-10-05" };
    // Mondays 5, 12, 19 Oct are before Thursday 22 Oct.
    expect(missedOccurrences(weekly, "2026-10-05", "2026-10-22")).toBe(3);
    expect(missedLabel("weekly", 3)).toBe("Missed 3 times");
  });
  it("stops at the end date", () => {
    const ended: RecurrenceRule = { ...daily, endDate: "2026-10-18" };
    expect(missedOccurrences(ended, "2026-10-17", "2026-10-22")).toBe(2);
  });
  it("singular and capped labels", () => {
    expect(missedLabel("daily", 0)).toBeNull();
    expect(missedLabel("daily", 1)).toBe("Missed 1 day");
    expect(missedLabel("weekly", 1)).toBe("Missed 1 time");
    expect(missedLabel("daily", MISSED_CAP)).toBe("Missed 99+ days");
  });
});
