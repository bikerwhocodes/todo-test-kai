import { describe, expect, it } from "vitest";

import { addDays, daysBetween, isIsoDate, isoWeekday, localToday, nextWeekday } from "./dates";

describe("isIsoDate", () => {
  it.each([
    ["2026-10-22", true],
    ["2028-02-29", true], // leap year
    ["2027-02-29", false],
    ["2100-02-29", false], // century, not a leap year
    ["2000-02-29", true],
    ["2026-13-01", false],
    ["2026-04-31", false],
    ["2026-1-01", false],
    ["20261022", false],
    ["", false],
  ])("%s -> %s", (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });
});

describe("localToday", () => {
  it.each([
    // [instant, zone, expected]
    ["2026-10-22T03:30:00Z", "UTC", "2026-10-22"],
    ["2026-10-22T03:30:00Z", "America/Toronto", "2026-10-21"],
    ["2026-10-22T03:30:00Z", "Asia/Tokyo", "2026-10-22"],
    ["2026-10-22T23:30:00Z", "Pacific/Auckland", "2026-10-23"],
    ["2026-10-22T10:00:00Z", "Pacific/Kiritimati", "2026-10-23"], // UTC+14
    ["2026-10-22T10:00:00Z", "Pacific/Pago_Pago", "2026-10-21"], // UTC-11
    // DST: Toronto springs forward 2026-03-08 02:00 and falls back 2026-11-01 02:00.
    ["2026-03-08T04:59:00Z", "America/Toronto", "2026-03-07"],
    ["2026-03-08T05:00:00Z", "America/Toronto", "2026-03-08"],
    ["2026-11-01T04:30:00Z", "America/Toronto", "2026-11-01"],
    ["2026-11-02T04:59:00Z", "America/Toronto", "2026-11-01"],
    ["2026-11-02T05:00:00Z", "America/Toronto", "2026-11-02"],
    // Leap day.
    ["2028-02-29T12:00:00Z", "Europe/London", "2028-02-29"],
  ])("%s in %s is %s", (instant, zone, expected) => {
    expect(localToday(zone, new Date(instant))).toBe(expected);
  });
});

describe("addDays", () => {
  it.each([
    ["2026-10-22", 1, "2026-10-23"],
    ["2026-10-31", 1, "2026-11-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2027-02-28", 1, "2027-03-01"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2026-03-07", 1, "2026-03-08"], // across a DST change
    ["2026-10-22", 0, "2026-10-22"],
    ["2026-10-22", 365, "2027-10-22"],
  ])("%s + %i = %s", (iso, days, expected) => {
    expect(addDays(iso, days)).toBe(expected);
  });

  it("rejects malformed dates", () => {
    expect(() => addDays("2027-02-29", 1)).toThrow(RangeError);
  });
});

describe("daysBetween", () => {
  it.each([
    ["2026-10-22", "2026-10-22", 0],
    ["2026-10-22", "2026-10-25", 3],
    ["2026-10-25", "2026-10-22", -3],
    ["2028-02-28", "2028-03-01", 2],
    ["2026-03-01", "2026-04-01", 31], // spans DST
  ])("%s -> %s = %i", (from, to, expected) => {
    expect(daysBetween(from, to)).toBe(expected);
  });
});

describe("isoWeekday / nextWeekday", () => {
  it.each([
    ["2026-10-19", 1],
    ["2026-10-22", 4],
    ["2026-10-25", 7],
    ["2028-02-29", 2],
  ])("%s is weekday %i", (iso, expected) => {
    expect(isoWeekday(iso)).toBe(expected);
  });

  it.each([
    // today is Thursday 2026-10-22
    [5, "2026-10-23"],
    [7, "2026-10-25"],
    [1, "2026-10-26"],
    [4, "2026-10-29"], // same weekday -> a week ahead, never today
    [3, "2026-10-28"],
  ])("next weekday %i after 2026-10-22 is %s", (weekday, expected) => {
    expect(nextWeekday("2026-10-22", weekday)).toBe(expected);
  });
});
