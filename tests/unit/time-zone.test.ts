import { describe, expect, it } from "vitest";
import { isTimeZoneMismatch, isValidTimeZone, normalizeTimeZone, timeZoneOptions } from "@/core/time-zone";

describe("isValidTimeZone", () => {
  it.each(["UTC", "Europe/London", "America/Toronto", "Asia/Kolkata"])("accepts %s", (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each([undefined, null, 42, "", "Mars/Olympus", "x".repeat(65), "Europe/London\n", "+05:30", "-0400"])(
    "rejects %j",
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(false);
    },
  );
});

describe("normalizeTimeZone", () => {
  it("keeps a valid zone", () => {
    expect(normalizeTimeZone("America/Toronto")).toBe("America/Toronto");
  });

  it("does not rewrite current names to legacy aliases", () => {
    expect(normalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("falls back to UTC for missing or unknown zones", () => {
    expect(normalizeTimeZone(undefined)).toBe("UTC");
    expect(normalizeTimeZone("Not/AZone")).toBe("UTC");
  });
});

describe("isTimeZoneMismatch", () => {
  it("is false for the same zone", () => {
    expect(isTimeZoneMismatch("Europe/London", "Europe/London")).toBe(false);
  });

  it("is true for different zones", () => {
    expect(isTimeZoneMismatch("Europe/London", "America/Toronto")).toBe(true);
  });

  it("treats aliases of one zone as the same", () => {
    expect(isTimeZoneMismatch("Asia/Kolkata", "Asia/Calcutta")).toBe(false);
    expect(isTimeZoneMismatch("Asia/Calcutta", "Asia/Kolkata")).toBe(false);
    expect(isTimeZoneMismatch("UTC", "Etc/UTC")).toBe(false);
  });

  it("is never a mismatch when the browser zone is missing or unknown", () => {
    expect(isTimeZoneMismatch("Europe/London", undefined)).toBe(false);
    expect(isTimeZoneMismatch("Europe/London", "")).toBe(false);
    expect(isTimeZoneMismatch("Europe/London", "Mars/Olympus")).toBe(false);
    expect(isTimeZoneMismatch("Europe/London", "+05:30")).toBe(false);
  });

  it("is a mismatch when the stored zone is unknown but the browser's is valid", () => {
    expect(isTimeZoneMismatch("Not/AZone", "Europe/London")).toBe(true);
  });
});

describe("timeZoneOptions", () => {
  it("is sorted and free of duplicates", () => {
    const options = timeZoneOptions("Europe/London");
    expect(options).toEqual([...new Set(options)].sort());
    expect(options).toContain("Europe/London");
    expect(options).toContain("America/Toronto");
  });

  it("always includes UTC", () => {
    expect(timeZoneOptions("Europe/London")).toContain("UTC");
  });

  it("includes the current zone even when it is an alias the list leaves out", () => {
    expect(timeZoneOptions("US/Eastern")).toContain("US/Eastern");
    expect(timeZoneOptions("Asia/Kolkata")).toContain("Asia/Kolkata");
  });
});
