import { describe, expect, it } from "vitest";
import {
  addDays,
  compareIsoDate,
  diffDays,
  fromDayNumber,
  isIsoDate,
  isValidTimeZone,
  localToday,
  maxIsoDate,
  minIsoDate,
  startOfIsoWeek,
  toDayNumber,
  weekdayOf,
} from "./dates";

describe("localToday", () => {
  it.each([
    // AC: LA vs Tokyo differ at 2026-11-01T06:30Z (LA is still PDT, 23:30 on Oct 31).
    ["America/Los_Angeles", "2026-11-01T06:30:00Z", "2026-10-31"],
    ["Asia/Tokyo", "2026-11-01T06:30:00Z", "2026-11-01"],
    ["UTC", "2026-11-01T06:30:00Z", "2026-11-01"],
    // Year boundary.
    ["Pacific/Kiritimati", "2026-12-31T10:00:00Z", "2027-01-01"], // UTC+14
    ["Pacific/Pago_Pago", "2027-01-01T10:00:00Z", "2026-12-31"], // UTC-11
    // Leap day.
    ["Europe/Berlin", "2028-02-28T23:30:00Z", "2028-02-29"],
    ["America/New_York", "2028-03-01T04:59:59Z", "2028-02-29"],
    ["America/New_York", "2028-03-01T05:00:00Z", "2028-03-01"],
    // Half-hour and 45-minute offsets.
    ["Asia/Kolkata", "2026-10-21T18:29:59Z", "2026-10-21"],
    ["Asia/Kolkata", "2026-10-21T18:30:00Z", "2026-10-22"],
    ["Asia/Kathmandu", "2026-10-21T18:15:00Z", "2026-10-22"],
    // DST transition days themselves.
    ["Europe/Berlin", "2026-10-25T00:59:59Z", "2026-10-25"], // 02:59:59 CEST
    ["Europe/Berlin", "2026-10-25T22:59:59Z", "2026-10-25"], // 23:59:59 CET
    ["Europe/Berlin", "2026-10-25T23:00:00Z", "2026-10-26"],
    ["America/Los_Angeles", "2026-11-01T06:59:59Z", "2026-10-31"], // 23:59:59 PDT
    ["America/Los_Angeles", "2026-11-01T07:00:00Z", "2026-11-01"], // 00:00 PDT
    ["America/Los_Angeles", "2026-11-01T09:30:00Z", "2026-11-01"], // 01:30 PST (repeated hour)
    ["America/Los_Angeles", "2026-11-02T07:59:59Z", "2026-11-01"], // 23:59:59 PST
    ["America/Los_Angeles", "2026-11-02T08:00:00Z", "2026-11-02"],
  ])("%s at %s is %s", (tz, instant, expected) => {
    expect(localToday(tz, new Date(instant))).toBe(expected);
  });

  it.each([
    ["Europe/Berlin", "2026-10-23T00:00:00Z", "2026-10-28T00:00:00Z"],
    ["America/Los_Angeles", "2026-10-29T00:00:00Z", "2026-11-04T00:00:00Z"],
    ["America/New_York", "2026-03-06T00:00:00Z", "2026-03-10T00:00:00Z"],
    ["Australia/Lord_Howe", "2026-04-03T00:00:00Z", "2026-04-07T00:00:00Z"], // 30-minute DST shift
  ])("%s: stepping every 15 min from %s to %s never skips or repeats a date", (tz, from, to) => {
    const seen: string[] = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * 60_000) {
      const d = localToday(tz, new Date(t));
      if (seen.at(-1) !== d) seen.push(d);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(diffDays(seen[i - 1]!, seen[i]!)).toBe(1);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it.each([
    ["Not/AZone", new Date("2026-01-01T00:00:00Z")],
    ["", new Date("2026-01-01T00:00:00Z")],
    ["UTC", new Date("nope")],
  ])("rejects tz=%j now=%s", (tz, now) => {
    expect(() => localToday(tz, now)).toThrow(RangeError);
  });

  it("isValidTimeZone", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe("isIsoDate", () => {
  it.each([
    ["2026-10-22", true],
    ["2028-02-29", true],
    ["2000-02-29", true],
    ["0001-01-01", true],
    ["9999-12-31", true],
    ["2026-02-29", false],
    ["1900-02-29", false],
    ["2026-04-31", false],
    ["2026-13-01", false],
    ["2026-00-10", false],
    ["2026-1-1", false],
    ["2026-10-22T00:00:00Z", false],
    ["0000-01-01", false],
    [" 2026-10-22", false],
    [20261022, false],
    [null, false],
  ])("%j → %s", (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });
});

describe("day numbers", () => {
  it.each([
    ["1970-01-01", 0],
    ["1969-12-31", -1],
    ["2000-03-01", 11017],
    ["2026-10-22", 20748],
  ])("%s ↔ %i", (date, n) => {
    expect(toDayNumber(date)).toBe(n);
    expect(fromDayNumber(n)).toBe(date);
  });

  it("round-trips every day 1900–2100 and agrees with Date.UTC", () => {
    const start = toDayNumber("1900-01-01");
    const end = toDayNumber("2100-12-31");
    for (let n = start; n <= end; n++) {
      const iso = fromDayNumber(n);
      expect(toDayNumber(iso)).toBe(n);
      if (n % 97 === 0) expect(new Date(n * 86_400_000).toISOString().slice(0, 10)).toBe(iso);
    }
  });

  it("rejects out-of-range results", () => {
    expect(() => addDays("9999-12-31", 1)).toThrow(RangeError);
    expect(() => addDays("0001-01-01", -1)).toThrow(RangeError);
    expect(() => toDayNumber("2026-02-30")).toThrow(RangeError);
  });
});

describe("addDays / diffDays", () => {
  it.each([
    ["2026-10-22", 1, "2026-10-23"],
    ["2026-10-31", 1, "2026-11-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2027-01-01", -1, "2026-12-31"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2028-02-29", 1, "2028-03-01"],
    ["2027-02-28", 1, "2027-03-01"],
    ["2100-02-28", 1, "2100-03-01"],
    ["2000-02-28", 1, "2000-02-29"],
    ["2026-10-24", 1, "2026-10-25"], // EU DST end
    ["2026-10-25", 1, "2026-10-26"],
    ["2026-10-31", 1, "2026-11-01"], // US DST end
    ["2026-11-01", 1, "2026-11-02"],
    ["2026-01-31", 30, "2026-03-02"],
    ["2026-10-22", 0, "2026-10-22"],
    ["2026-10-22", 365, "2027-10-22"],
    ["2028-01-01", 366, "2029-01-01"],
  ])("%s + %i = %s", (date, n, expected) => {
    expect(addDays(date, n)).toBe(expected);
    expect(diffDays(date, expected)).toBe(n);
  });

  it("rejects non-integer offsets", () => {
    expect(() => addDays("2026-10-22", 1.5)).toThrow(RangeError);
  });
});

describe("weekdays and weeks", () => {
  it.each([
    ["1970-01-01", 4],
    ["2026-10-22", 4], // Thursday
    ["2026-10-25", 0], // Sunday
    ["2026-10-26", 1],
    ["2028-02-29", 2],
    ["1900-01-01", 1],
  ])("weekdayOf(%s) = %i", (date, wd) => {
    expect(weekdayOf(date)).toBe(wd);
  });

  it.each([
    ["2026-10-22", "2026-10-19"],
    ["2026-10-19", "2026-10-19"],
    ["2026-10-25", "2026-10-19"], // Sunday belongs to the week starting the previous Monday
    ["2027-01-01", "2026-12-28"],
    ["2028-03-01", "2028-02-28"],
  ])("startOfIsoWeek(%s) = %s", (date, monday) => {
    expect(startOfIsoWeek(date)).toBe(monday);
  });
});

describe("compare / max / min", () => {
  it.each([
    ["2026-10-22", "2026-10-23", -1],
    ["2026-10-23", "2026-10-22", 1],
    ["2026-10-22", "2026-10-22", 0],
    ["2026-09-30", "2026-10-01", -1],
    ["2025-12-31", "2026-01-01", -1],
  ])("compare(%s, %s) = %i", (a, b, c) => {
    expect(compareIsoDate(a, b)).toBe(c);
    expect(maxIsoDate(a, b)).toBe(c >= 0 ? a : b);
    expect(minIsoDate(a, b)).toBe(c <= 0 ? a : b);
  });

  it("rejects invalid input", () => {
    expect(() => compareIsoDate("2026-10-22", "tomorrow")).toThrow(RangeError);
  });
});
