import { describe, expect, it } from "vitest";
import { describeEnd, describeRule, formatDayMonth } from "@/core/recurrence/describe";

describe("describeRule", () => {
  it.each([
    [{ kind: "daily", interval: 1 }, "Every day"],
    [{ kind: "daily", interval: 3 }, "Every 3 days"],
    [{ kind: "weekly", interval: 1, weekdays: [1] }, "Every week on Mon"],
    [{ kind: "weekly", interval: 2, weekdays: [3, 1] }, "Every 2 weeks on Mon, Wed"],
    [{ kind: "weekly", interval: 1, weekdays: [0, 5, 1, 1] }, "Every week on Mon, Fri, Sun"],
    [{ kind: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5] }, "Every weekday"],
    [{ kind: "weekly", interval: 3, weekdays: [5, 4, 3, 2, 1] }, "Every 3 weeks on weekdays"],
    [{ kind: "weekly", interval: 1, weekdays: [6, 0] }, "Every weekend"],
    [{ kind: "weekly", interval: 2, weekdays: [0, 6] }, "Every 2 weeks on weekends"],
    [{ kind: "weekly", interval: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] }, "Every day"],
    [{ kind: "weekly", interval: 2, weekdays: [0, 1, 2, 3, 4, 5, 6] }, "Every 2 weeks on every day"],
  ] as const)("%j -> %s", (rule, text) => expect(describeRule(rule)).toBe(text));

  it("tolerates half-filled form input", () => {
    expect(describeRule({ kind: "daily", interval: Number.NaN })).toBe("Every day");
    expect(describeRule({ kind: "weekly", interval: 0, weekdays: [] })).toBe("Every week");
    expect(describeRule({ kind: "weekly", interval: 2, weekdays: null })).toBe("Every 2 weeks");
  });

  it("ignores the end date", () => {
    expect(describeRule({ kind: "daily", interval: 1, endDate: "2026-12-31" })).toBe("Every day");
  });
});

describe("describeEnd", () => {
  const today = "2026-10-22";
  it("is null without an end date", () => {
    expect(describeEnd(null, today)).toBeNull();
    expect(describeEnd(undefined, today)).toBeNull();
  });
  it("says Ends for today and later, Ended before", () => {
    expect(describeEnd("2026-12-31", today)).toBe("Ends 31 Dec");
    expect(describeEnd("2026-10-22", today)).toBe("Ends 22 Oct");
    expect(describeEnd("2026-10-03", today)).toBe("Ended 3 Oct");
  });
  it("adds the year when it differs from today's", () => {
    expect(describeEnd("2027-01-15", today)).toBe("Ends 15 Jan 2027");
    expect(describeEnd("2025-06-01", today)).toBe("Ended 1 Jun 2025");
  });
});

describe("formatDayMonth", () => {
  it("never shifts the date with the host zone", () => {
    expect(formatDayMonth("2026-01-01", "2026-10-22")).toBe("1 Jan");
    expect(formatDayMonth("2026-12-31", "2026-10-22")).toBe("31 Dec");
  });
  it("returns malformed input unchanged", () => {
    expect(formatDayMonth("soon", "2026-10-22")).toBe("soon");
  });
});
