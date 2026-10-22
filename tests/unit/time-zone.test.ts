import { describe, expect, it } from "vitest";
import { isValidTimeZone, normalizeTimeZone } from "@/core/time-zone";

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
