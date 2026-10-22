import { describe, expect, it } from "vitest";

import { parseQuickAdd, quickAddSegments, type QuickAddResult } from "./parse";

// Thursday.
const TODAY = "2026-10-22";

interface Project {
  id: string;
  name: string;
}

const PROJECTS: Project[] = [
  { id: "p-client", name: "Client" },
  { id: "p-client-a", name: "Client A" },
  { id: "p-home", name: "Home" },
  { id: "p-deep", name: "Deep Work Q4" },
];

type Fields = Omit<QuickAddResult<Project>, "tokens" | "project"> & { project: string | null };

function parse(text: string, projects: Project[] = PROJECTS, today = TODAY) {
  return parseQuickAdd({ text, today, projects });
}

function fields(text: string, projects?: Project[], today?: string): Fields {
  const r = parse(text, projects, today);
  return {
    title: r.title,
    project: r.project?.id ?? null,
    priority: r.priority,
    estimateMin: r.estimateMin,
    deadline: r.deadline,
  };
}

const none = { project: null, priority: null, estimateMin: null, deadline: null };

describe("parseQuickAdd: acceptance example", () => {
  it("parses 'Fix build #Client A !p1 ~45m ^fri'", () => {
    const result = parse("Fix build #Client A !p1 ~45m ^fri");
    expect(result).toEqual({
      title: "Fix build",
      project: PROJECTS[1],
      priority: 1,
      estimateMin: 45,
      deadline: "2026-10-23",
      tokens: [
        { kind: "project", start: 10, end: 19, text: "#Client A" },
        { kind: "priority", start: 20, end: 23, text: "!p1" },
        { kind: "estimate", start: 24, end: 28, text: "~45m" },
        { kind: "deadline", start: 29, end: 33, text: "^fri" },
      ],
    });
  });
});

describe("parseQuickAdd: fields", () => {
  it.each<[string, Fields]>([
    // Title only.
    ["Buy milk", { title: "Buy milk", ...none }],
    ["  Buy   milk  ", { title: "Buy milk", ...none }],
    ["", { title: "", ...none }],

    // Tokens anywhere, in any order.
    ["!p2 Call mum ^tomorrow", { ...none, title: "Call mum", priority: 2, deadline: "2026-10-23" }],
    ["Plan #Home trip", { ...none, title: "Plan trip", project: "p-home" }],
    ["#home lowercase", { ...none, title: "lowercase", project: "p-home" }],
    ["Review #Deep Work Q4 notes", { ...none, title: "Review notes", project: "p-deep" }],

    // Longest project wins; a shorter one still matches when the longer doesn't.
    ["x #Client A", { ...none, title: "x", project: "p-client-a" }],
    ["x #Client B", { ...none, title: "x B", project: "p-client" }],
    ["x #ClientA", { ...none, title: "x #ClientA" }],

    // Priority.
    ["t !p1", { ...none, title: "t", priority: 1 }],
    ["t !P4", { ...none, title: "t", priority: 4 }],
    ["t !p0", { ...none, title: "t !p0" }],
    ["t !p5", { ...none, title: "t !p5" }],
    ["t !1", { ...none, title: "t !1" }],
    ["Wow!p1", { ...none, title: "Wow!p1" }],

    // Estimate.
    ["t ~30m", { ...none, title: "t", estimateMin: 30 }],
    ["t ~1h", { ...none, title: "t", estimateMin: 60 }],
    ["t ~1h30", { ...none, title: "t", estimateMin: 90 }],
    ["t ~1h30m", { ...none, title: "t", estimateMin: 90 }],
    ["t ~2H5M", { ...none, title: "t", estimateMin: 125 }],
    ["t ~90m", { ...none, title: "t", estimateMin: 90 }],
    ["t ~24h", { ...none, title: "t", estimateMin: 1440 }],
    ["t ~1440m", { ...none, title: "t", estimateMin: 1440 }],
    ["t ~1441m", { ...none, title: "t ~1441m" }],
    ["t ~24h1", { ...none, title: "t ~24h1" }],
    ["t ~0m", { ...none, title: "t ~0m" }],
    ["t ~1h60", { ...none, title: "t ~1h60" }],
    ["t ~1.5h", { ...none, title: "t ~1.5h" }],
    ["t ~30", { ...none, title: "t ~30" }],
    ["t ~", { ...none, title: "t ~" }],

    // Deadline, relative to today (Thursday 2026-10-22).
    ["t ^today", { ...none, title: "t", deadline: "2026-10-22" }],
    ["t ^Tomorrow", { ...none, title: "t", deadline: "2026-10-23" }],
    ["t ^fri", { ...none, title: "t", deadline: "2026-10-23" }],
    ["t ^friday", { ...none, title: "t", deadline: "2026-10-23" }],
    ["t ^thu", { ...none, title: "t", deadline: "2026-10-29" }],
    ["t ^mon", { ...none, title: "t", deadline: "2026-10-26" }],
    ["t ^SUN", { ...none, title: "t", deadline: "2026-10-25" }],
    ["t ^2026-12-01", { ...none, title: "t", deadline: "2026-12-01" }],
    ["t ^2028-02-29", { ...none, title: "t", deadline: "2028-02-29" }],
    ["t ^2027-02-29", { ...none, title: "t ^2027-02-29" }],
    ["t ^2026-13-01", { ...none, title: "t ^2026-13-01" }],
    ["t ^someday", { ...none, title: "t ^someday" }],
    ["t ^fri,", { ...none, title: "t ^fri," }],
  ])("%j", (text, expected) => {
    expect(fields(text)).toEqual(expected);
  });
});

describe("parseQuickAdd: unknown and ambiguous tokens stay in the title", () => {
  it.each<[string, Fields]>([
    ["Email #Unknown team", { ...none, title: "Email #Unknown team" }],
    ["Tag #", { ...none, title: "Tag #" }],
    ["C# tips", { ...none, title: "C# tips" }],
    ["a#Home", { ...none, title: "a#Home" }],
    // Repeated kinds are ambiguous: every token of that kind stays.
    ["t !p1 !p2 ~5m", { ...none, title: "t !p1 !p2", estimateMin: 5 }],
    ["t ^fri ^mon", { ...none, title: "t ^fri ^mon" }],
    ["t ~5m ~10m !p3", { ...none, title: "t ~5m ~10m", priority: 3 }],
    ["t #Home #Client", { ...none, title: "t #Home #Client" }],
    // An invalid duplicate doesn't make the valid one ambiguous.
    ["t !p1 !p9", { ...none, title: "t !p9", priority: 1 }],
    // Only tokens: title is empty and the caller rejects it.
    ["!p1 ^fri", { ...none, title: "", priority: 1, deadline: "2026-10-23" }],
  ])("%j", (text, expected) => {
    expect(fields(text)).toEqual(expected);
  });

  it("with no projects, # never matches", () => {
    expect(fields("Plan #Home trip", [])).toEqual({ ...none, title: "Plan #Home trip" });
  });

  it("names that differ only by case resolve to the exact-case one, else stay", () => {
    const projects = [
      { id: "a", name: "Work" },
      { id: "b", name: "work" },
    ];
    expect(fields("t #work", projects).project).toBe("b");
    expect(fields("t #Work", projects).project).toBe("a");
    expect(fields("t #WORK", projects)).toEqual({ ...none, title: "t #WORK" });
  });
});

describe("parseQuickAdd: today drives relative dates", () => {
  it.each([
    // [today, token, expected]
    ["2026-10-23", "^fri", "2026-10-30"], // on a Friday, ^fri is next week
    ["2028-02-28", "^tomorrow", "2028-02-29"], // leap day
    ["2027-02-28", "^tomorrow", "2027-03-01"],
    ["2026-12-31", "^tomorrow", "2027-01-01"],
    ["2026-12-29", "^mon", "2027-01-04"],
    ["2026-11-01", "^today", "2026-11-01"], // DST change day in North America
  ])("on %s, %s -> %s", (today, token, expected) => {
    expect(fields(`t ${token}`, PROJECTS, today).deadline).toBe(expected);
  });
});

describe("quickAddSegments", () => {
  it("splits text into plain and highlighted segments", () => {
    const text = "Fix build #Client A !p1 x";
    const { tokens } = parse(text);
    expect(quickAddSegments(text, tokens)).toEqual([
      { text: "Fix build ", kind: null },
      { text: "#Client A", kind: "project" },
      { text: " ", kind: null },
      { text: "!p1", kind: "priority" },
      { text: " x", kind: null },
    ]);
  });

  it("round-trips the input", () => {
    const text = "  !p2 Call ~1h30 #Home ^2026-12-01  ";
    const { tokens } = parse(text);
    expect(
      quickAddSegments(text, tokens)
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });
});
