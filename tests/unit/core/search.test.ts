import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_QUERY,
  SEARCH_TEXT_MAX,
  escapeLike,
  hasActiveFilters,
  normalizeSearchText,
  parseSearchQuery,
  searchHref,
  searchQueryToParams,
  shouldFocusSearch,
  type SearchQuery,
  type ShortcutKeyEvent,
} from "@/core/search";

const ID = "0b8f5f3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

describe("parseSearchQuery", () => {
  it("defaults to open tasks with no other filter", () => {
    expect(parseSearchQuery({})).toEqual(DEFAULT_SEARCH_QUERY);
    expect(DEFAULT_SEARCH_QUERY).toEqual({
      q: "",
      project: null,
      priority: null,
      status: "open",
      due: null,
      blocked: null,
      estimate: null,
    });
  });

  it("reads every filter", () => {
    expect(
      parseSearchQuery({
        q: "milk",
        project: ID,
        priority: "2",
        status: "done",
        due: "overdue",
        blocked: "1",
        estimate: "0",
      }),
    ).toEqual({ q: "milk", project: ID, priority: 2, status: "done", due: "overdue", blocked: true, estimate: false });
  });

  it.each([
    ["q", "", { q: "" }],
    ["project", "inbox", { project: "inbox" }],
    ["project", ID.toUpperCase(), { project: ID }],
    ["priority", "1", { priority: 1 }],
    ["priority", "4", { priority: 4 }],
    ["status", "open", { status: "open" }],
    ["status", "skipped", { status: "skipped" }],
    ["status", "all", { status: "all" }],
    ["due", "has", { due: "has" }],
    ["due", "none", { due: "none" }],
    ["blocked", "0", { blocked: false }],
    ["estimate", "1", { estimate: true }],
  ] as const)("%s=%j", (key, value, expected) => {
    expect(parseSearchQuery({ [key]: value })).toEqual({ ...DEFAULT_SEARCH_QUERY, ...expected });
  });

  it.each([
    ["project", "not-a-uuid"],
    ["project", `${ID}x`],
    ["project", "Inbox"],
    ["project", ""],
    ["project", "00000000-0000-0000-0000-00000000000g"],
    ["priority", "0"],
    ["priority", "5"],
    ["priority", "1.0"],
    ["priority", " 1"],
    ["priority", "high"],
    ["status", "OPEN"],
    ["status", "archived"],
    ["due", "today"],
    ["due", ""],
    ["blocked", "true"],
    ["blocked", "yes"],
    ["estimate", "2"],
    ["estimate", ""],
  ])("drops invalid %s=%j", (key, value) => {
    expect(parseSearchQuery({ [key]: value })).toEqual(DEFAULT_SEARCH_QUERY);
  });

  it("ignores unknown keys", () => {
    expect(parseSearchQuery({ sort: "title", page: "2" })).toEqual(DEFAULT_SEARCH_QUERY);
  });

  it("takes the first value of a repeated key", () => {
    expect(parseSearchQuery({ q: ["milk", "eggs"], priority: ["3", "1"], status: ["bogus", "done"] })).toEqual({
      ...DEFAULT_SEARCH_QUERY,
      q: "milk",
      priority: 3,
    });
    expect(parseSearchQuery({ q: [], project: undefined })).toEqual(DEFAULT_SEARCH_QUERY);
  });

  it("trims the text and collapses whitespace and control characters", () => {
    expect(parseSearchQuery({ q: "  buy \t\n  milk  " }).q).toBe("buy milk");
    expect(parseSearchQuery({ q: "a\u0000b\u007fc" }).q).toBe("a b c");
    expect(parseSearchQuery({ q: " \n\t " }).q).toBe("");
  });

  it(`truncates the text to ${SEARCH_TEXT_MAX} characters`, () => {
    expect(parseSearchQuery({ q: "x".repeat(500) }).q).toBe("x".repeat(SEARCH_TEXT_MAX));
    expect(parseSearchQuery({ q: "x".repeat(SEARCH_TEXT_MAX) }).q).toHaveLength(SEARCH_TEXT_MAX);
    // Cut on whole characters, and no trailing space left at the cut.
    expect(normalizeSearchText("😀".repeat(300))).toBe("😀".repeat(SEARCH_TEXT_MAX));
    expect(normalizeSearchText(`${"x".repeat(SEARCH_TEXT_MAX - 1)} yz`)).toBe("x".repeat(SEARCH_TEXT_MAX - 1));
  });
});

describe("searchQueryToParams", () => {
  const full: SearchQuery = {
    q: "buy milk",
    project: ID,
    priority: 1,
    status: "all",
    due: "has",
    blocked: false,
    estimate: true,
  };

  it("leaves out defaults, so the default search is a bare /search", () => {
    expect(searchQueryToParams(DEFAULT_SEARCH_QUERY).toString()).toBe("");
    expect(searchHref(DEFAULT_SEARCH_QUERY)).toBe("/search");
    expect(searchQueryToParams({ ...DEFAULT_SEARCH_QUERY, q: "   " }).toString()).toBe("");
  });

  it("writes keys in a fixed order", () => {
    expect([...searchQueryToParams(full).keys()]).toEqual([
      "q",
      "project",
      "priority",
      "status",
      "due",
      "blocked",
      "estimate",
    ]);
    expect(searchHref(full)).toBe(
      `/search?q=buy+milk&project=${ID}&priority=1&status=all&due=has&blocked=0&estimate=1`,
    );
  });

  it("writes status only when it isn't open", () => {
    expect(searchQueryToParams({ ...DEFAULT_SEARCH_QUERY, status: "done" }).toString()).toBe("status=done");
    expect(searchQueryToParams({ ...DEFAULT_SEARCH_QUERY, status: "open" }).toString()).toBe("");
  });

  it.each<[string, SearchQuery]>([
    ["default", DEFAULT_SEARCH_QUERY],
    ["everything", full],
    ["inbox", { ...DEFAULT_SEARCH_QUERY, project: "inbox", blocked: true, estimate: false, due: "overdue" }],
    ["odd text", { ...DEFAULT_SEARCH_QUERY, q: "50% & a_b \\ =?#+" }],
    ["no priority", { ...DEFAULT_SEARCH_QUERY, priority: 4, status: "skipped", due: "none" }],
  ])("round-trips %s", (_name, query) => {
    const params = searchQueryToParams(query);
    expect(parseSearchQuery(Object.fromEntries(params))).toEqual(query);
    // Through a real URL too.
    const url = new URL(searchHref(query), "http://localhost");
    expect(parseSearchQuery(Object.fromEntries(url.searchParams))).toEqual(query);
  });

  it("canonicalises a messy URL", () => {
    const messy = { estimate: "1", q: "  milk  ", status: "open", project: ID.toUpperCase(), due: "", priority: "9" };
    expect(searchHref(parseSearchQuery(messy))).toBe(`/search?q=milk&project=${ID}&estimate=1`);
  });

  it("hasActiveFilters is true for anything but the default", () => {
    expect(hasActiveFilters(DEFAULT_SEARCH_QUERY)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_SEARCH_QUERY, q: "x" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_SEARCH_QUERY, status: "all" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_SEARCH_QUERY, estimate: false })).toBe(true);
  });
});

describe("escapeLike", () => {
  it.each([
    ["milk", "milk"],
    ["50%", "50\\%"],
    ["snake_case", "snake\\_case"],
    ["C:\\temp", "C:\\\\temp"],
    ["\\%_", "\\\\\\%\\_"],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });
});

describe("shouldFocusSearch", () => {
  const key = (k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });
  const body = { tagName: "BODY" };

  it("fires on a bare / outside fields", () => {
    expect(shouldFocusSearch(key("/"), body)).toBe(true);
    expect(shouldFocusSearch(key("/"), null)).toBe(true);
    expect(shouldFocusSearch(key("/"), { tagName: "BUTTON" })).toBe(true);
    expect(shouldFocusSearch(key("/"), { tagName: "A" })).toBe(true);
  });

  it("ignores other keys and modified /", () => {
    expect(shouldFocusSearch(key("?"), body)).toBe(false);
    expect(shouldFocusSearch(key("k"), body)).toBe(false);
    expect(shouldFocusSearch(key("/", { ctrlKey: true }), body)).toBe(false);
    expect(shouldFocusSearch(key("/", { metaKey: true }), body)).toBe(false);
    expect(shouldFocusSearch(key("/", { altKey: true }), body)).toBe(false);
  });

  it("ignores events already handled or mid-composition", () => {
    expect(shouldFocusSearch(key("/", { defaultPrevented: true }), body)).toBe(false);
    expect(shouldFocusSearch(key("/", { isComposing: true }), body)).toBe(false);
  });

  it("leaves typing in fields alone", () => {
    for (const target of [
      { tagName: "INPUT" },
      { tagName: "INPUT", type: "text" },
      { tagName: "INPUT", type: "search" },
      { tagName: "INPUT", type: "number" },
      { tagName: "INPUT", type: "date" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      expect(shouldFocusSearch(key("/"), target), JSON.stringify(target)).toBe(false);
    }
  });

  it("fires on inputs that take no text, such as a task's checkbox", () => {
    expect(shouldFocusSearch(key("/"), { tagName: "INPUT", type: "checkbox" })).toBe(true);
    expect(shouldFocusSearch(key("/"), { tagName: "INPUT", type: "submit" })).toBe(true);
  });

  it("does nothing inside an open dialog", () => {
    expect(shouldFocusSearch(key("/"), { tagName: "BUTTON", inDialog: true })).toBe(false);
  });
});
