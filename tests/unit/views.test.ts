import { describe, expect, it } from "vitest";
import { UPCOMING_DAYS, todayCutoff, upcomingRange } from "@/core/views";

describe("todayCutoff", () => {
  it("is today itself (overdue and today are both in Today)", () => {
    expect(todayCutoff("2026-10-22")).toBe("2026-10-22");
    expect(todayCutoff("2028-02-29")).toBe("2028-02-29");
  });

  it("rejects a non-date", () => {
    expect(() => todayCutoff("2026-02-29")).toThrow(RangeError);
    expect(() => todayCutoff("22/10/2026")).toThrow(RangeError);
  });
});

describe("upcomingRange", () => {
  it("covers tomorrow through today + 7 by default", () => {
    expect(UPCOMING_DAYS).toBe(7);
    expect(upcomingRange("2026-10-22")).toEqual({ from: "2026-10-23", to: "2026-10-29" });
  });

  it.each([
    // Month end.
    ["2026-10-31", { from: "2026-11-01", to: "2026-11-07" }],
    ["2026-04-28", { from: "2026-04-29", to: "2026-05-05" }],
    // Year end.
    ["2026-12-31", { from: "2027-01-01", to: "2027-01-07" }],
    ["2026-12-27", { from: "2026-12-28", to: "2027-01-03" }],
    // February in a leap year, and in a common year.
    ["2028-02-28", { from: "2028-02-29", to: "2028-03-06" }],
    ["2028-02-29", { from: "2028-03-01", to: "2028-03-07" }],
    ["2027-02-28", { from: "2027-03-01", to: "2027-03-07" }],
    ["2027-02-22", { from: "2027-02-23", to: "2027-03-01" }],
    // Century rule: 2100 is not a leap year.
    ["2100-02-28", { from: "2100-03-01", to: "2100-03-07" }],
  ])("from %s", (today, range) => {
    expect(upcomingRange(today)).toEqual(range);
  });

  it("takes a custom length; one day is just tomorrow", () => {
    expect(upcomingRange("2026-10-22", 1)).toEqual({ from: "2026-10-23", to: "2026-10-23" });
    expect(upcomingRange("2026-12-31", 31)).toEqual({ from: "2027-01-01", to: "2027-01-31" });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s days", (days) => {
    expect(() => upcomingRange("2026-10-22", days)).toThrow(RangeError);
  });

  it("rejects a non-date", () => {
    expect(() => upcomingRange("2027-02-29")).toThrow(RangeError);
  });
});
