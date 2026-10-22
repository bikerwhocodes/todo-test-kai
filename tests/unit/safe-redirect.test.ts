import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/lib/safe-redirect";

describe("safeNextPath", () => {
  it.each([
    ["/today", "/today"],
    ["/projects/42?tab=done#top", "/projects/42?tab=done#top"],
    ["/search?q=a%20b", "/search?q=a%20b"],
  ])("keeps same-origin path %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "today",
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "/a/..//evil.example/x",
    "/.//evil.example",
    "/%2e%2e//evil.example",
    "/a/../\\evil.example",
    "javascript:alert(1)",
    "/login",
    "/signup?x=1",
  ])("falls back for %j", (input) => {
    expect(safeNextPath(input)).toBe(DEFAULT_AFTER_LOGIN);
  });
});
