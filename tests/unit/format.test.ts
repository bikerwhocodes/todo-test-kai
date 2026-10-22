import { describe, expect, it } from "vitest";
import { daysBetween, formatDeadline, formatEstimate, formatPriority, isoDateInTimeZone } from "@/core/format";

describe("formatEstimate", () => {
  it.each([
    [1, "1m"],
    [45, "45m"],
    [60, "1h"],
    [90, "1h 30m"],
    [1440, "24h"],
  ])("%i -> %s", (minutes, text) => expect(formatEstimate(minutes)).toBe(text));
});

describe("formatPriority", () => {
  it("labels P1-P3 and hides 'none'", () => {
    expect([1, 2, 3, 4].map(formatPriority)).toEqual(["P1", "P2", "P3", null]);
  });
});

describe("isoDateInTimeZone", () => {
  const instant = new Date("2026-10-22T02:30:00Z");
  it("uses the zone's calendar date", () => {
    expect(isoDateInTimeZone(instant, "UTC")).toBe("2026-10-22");
    expect(isoDateInTimeZone(instant, "America/Toronto")).toBe("2026-10-21");
    expect(isoDateInTimeZone(instant, "Asia/Tokyo")).toBe("2026-10-22");
  });
});

describe("formatDeadline", () => {
  const today = "2026-10-22";
  it("names nearby days", () => {
    expect(formatDeadline("2026-10-22", today)).toBe("Today");
    expect(formatDeadline("2026-10-23", today)).toBe("Tomorrow");
    expect(formatDeadline("2026-10-21", today)).toBe("Yesterday");
  });
  it("shows the date without shifting it, adding the year only when it differs", () => {
    expect(formatDeadline("2026-11-07", today)).toBe("Sat 7 Nov");
    expect(formatDeadline("2027-01-03", today)).toBe("3 Jan 2027");
  });
  it("counts days across a DST change", () => {
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});
