import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ./next-mocks.
vi.mock("next/headers", async () => (await import("./next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("./next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("./next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("./next-mocks")).reactCache }));

import SearchPage from "@/app/(app)/search/page";
import { SearchFilters } from "@/components/search/search-filters";
import { TaskRow } from "@/components/tasks/task-row";
import type { TaskView } from "@/components/tasks/types";
import { localToday } from "@/core/dates";
import { DEFAULT_SEARCH_QUERY, SEARCH_LIMIT, parseSearchQuery, type SearchParamsInput, type SearchQuery } from "@/core/search";
import { db } from "@/server/db";
import { tasks, type Project, type TaskStatus } from "@/server/db/schema";
import { addBlocker } from "@/server/repo/dependencies";
import { createProject, setProjectArchived } from "@/server/repo/projects";
import { searchTasks } from "@/server/repo/search";
import { addSubtask } from "@/server/repo/subtasks";
import { createTask, getTask } from "@/server/repo/tasks";
import { createUser, resetDb } from "./helpers";
import { stringsIn } from "./isolation/world";
import { actAs } from "./next-mocks";
import { signIn } from "./session-helpers";

// The user's local date in every test below unless one says otherwise.
const TODAY = "2026-03-10";

type Seed = {
  title: string;
  project?: Project | null;
  priority?: number;
  status?: TaskStatus;
  deadline?: string | null;
  estimateMin?: number | null;
  description?: string | null;
};

let createdAt = Date.parse("2026-01-01T00:00:00Z");

/** Inserts one task with exactly these fields; each is created a minute after the last. */
async function seedTask(userId: string, s: Seed): Promise<string> {
  createdAt += 60_000;
  const [row] = await db
    .insert(tasks)
    .values({
      userId,
      title: s.title,
      projectId: s.project?.id ?? null,
      priority: s.priority ?? 4,
      status: s.status ?? "open",
      completedAt: s.status === "done" ? new Date(createdAt) : null,
      deadline: s.deadline ?? null,
      estimateMin: s.estimateMin ?? null,
      description: s.description ?? null,
      createdAt: new Date(createdAt),
    })
    .returning({ id: tasks.id });
  return row!.id;
}

describe("searchTasks", () => {
  let userId: string;
  let home: Project;
  let work: Project;
  // Task ids by key; see the table in beforeAll.
  const t: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    userId = await createUser("Ada");
    home = await createProject(userId, { name: "Home" });
    work = await createProject(userId, { name: "Work" });

    const seeds: Record<string, Seed> = {
      milk: { title: "Buy milk", priority: 1, deadline: "2026-03-09", estimateMin: 10 },
      report: { title: "Write report", project: work, priority: 2, deadline: TODAY, estimateMin: 60, description: "Quarterly numbers" },
      tap: { title: "Fix tap", project: home, priority: 1, deadline: "2026-03-01", description: "Kitchen MILK jug" },
      paint: { title: "Paint fence", project: home, estimateMin: 120 },
      taxes: { title: "File taxes", priority: 3, status: "done", deadline: "2026-03-01", estimateMin: 30 },
      gym: { title: "Gym", project: home, status: "skipped" },
      pct: { title: "Save 50% more", deadline: "2026-04-01" },
      pctDecoy: { title: "Save 50 more" },
      under: { title: "snake_case rename", project: work, priority: 2, estimateMin: 15 },
      underDecoy: { title: "snake case notes", project: work },
      slash: { title: "Clean C:\\temp", project: home, priority: 3, deadline: "2026-03-11" },
    };
    for (const [key, seed] of Object.entries(seeds)) t[key] = await seedTask(userId, seed);

    // Blocked (open, with an open blocker): paint and milk. report waits only on a done
    // task, and gym is skipped, so neither counts.
    await addBlocker(userId, t.paint!, t.tap!);
    await addBlocker(userId, t.report!, t.taxes!);
    await addBlocker(userId, t.gym!, t.milk!);
    await addBlocker(userId, t.milk!, t.pct!);

    // Archived projects are still searched.
    await setProjectArchived(userId, work.id, true);

    // Someone else with look-alike tasks, all of which match the filters below.
    const other = await createUser("Bob");
    const otherProject = await createProject(other, { name: "Home" });
    const otherA = await seedTask(other, { title: "Buy milk", priority: 1, deadline: "2026-03-09", estimateMin: 10 });
    const otherB = await seedTask(other, { title: "Fix milk tap", project: otherProject, priority: 1, deadline: "2026-03-01" });
    await addBlocker(other, otherA, otherB);
  });

  const search = async (params: SearchParamsInput, today = TODAY) =>
    (await searchTasks(userId, parseSearchQuery(params), today)).tasks.map((task) => task.id);

  /** Exact set, any order. */
  async function expectMatches(params: SearchParamsInput, keys: string[]) {
    const expected = keys.map((k) => t[k]!).sort();
    expect((await search(params)).sort(), JSON.stringify(params)).toEqual(expected);
  }

  const OPEN = ["milk", "report", "tap", "paint", "pct", "pctDecoy", "under", "underDecoy", "slash"];
  const ALL = [...OPEN, "taxes", "gym"];

  it("with no filters returns the open tasks", async () => {
    await expectMatches({}, OPEN);
  });

  describe("text", () => {
    it("matches title or description, case-insensitively", async () => {
      await expectMatches({ q: "milk" }, ["milk", "tap"]);
      await expectMatches({ q: "MILK" }, ["milk", "tap"]);
      await expectMatches({ q: "mIlK" }, ["milk", "tap"]);
      await expectMatches({ q: "quarterly num" }, ["report"]);
    });

    it("matches several words as one substring", async () => {
      await expectMatches({ q: "paint fence" }, ["paint"]);
      await expectMatches({ q: "fence paint" }, []);
      await expectMatches({ q: "  paint \n fence " }, ["paint"]);
    });

    it("treats %, _ and \\ literally", async () => {
      await expectMatches({ q: "50%" }, ["pct"]);
      await expectMatches({ q: "%" }, ["pct"]);
      await expectMatches({ q: "e_c" }, ["under"]);
      await expectMatches({ q: "_" }, ["under"]);
      await expectMatches({ q: "c:\\" }, ["slash"]);
      await expectMatches({ q: "\\" }, ["slash"]);
    });

    it("searches done and skipped tasks with status", async () => {
      await expectMatches({ q: "taxes" }, []);
      await expectMatches({ q: "taxes", status: "done" }, ["taxes"]);
      await expectMatches({ q: "gym", status: "all" }, ["gym"]);
    });
  });

  it("filters by project, including the Inbox and archived projects", async () => {
    await expectMatches({ project: "inbox" }, ["milk", "pct", "pctDecoy"]);
    await expectMatches({ project: home.id }, ["tap", "paint", "slash"]);
    await expectMatches({ project: work.id }, ["report", "under", "underDecoy"]);
    await expectMatches({ project: "00000000-0000-4000-8000-000000000000" }, []);
  });

  it("filters by priority", async () => {
    await expectMatches({ priority: "1" }, ["milk", "tap"]);
    await expectMatches({ priority: "2" }, ["report", "under"]);
    await expectMatches({ priority: "4" }, ["paint", "pct", "pctDecoy", "underDecoy"]);
  });

  it("filters by status", async () => {
    await expectMatches({ status: "open" }, OPEN);
    await expectMatches({ status: "done" }, ["taxes"]);
    await expectMatches({ status: "skipped" }, ["gym"]);
    await expectMatches({ status: "all" }, ALL);
  });

  it("filters by deadline", async () => {
    // A deadline of today is not overdue; a done task is never overdue.
    await expectMatches({ due: "overdue" }, ["milk", "tap"]);
    await expectMatches({ due: "overdue", status: "all" }, ["milk", "tap"]);
    await expectMatches({ due: "has" }, ["milk", "report", "tap", "pct", "slash"]);
    await expectMatches({ due: "has", status: "all" }, ["milk", "report", "tap", "pct", "slash", "taxes"]);
    await expectMatches({ due: "none" }, ["paint", "pctDecoy", "under", "underDecoy"]);
  });

  it("filters by blocked: open with an open blocker", async () => {
    await expectMatches({ blocked: "1" }, ["paint", "milk"]);
    await expectMatches({ blocked: "1", status: "all" }, ["paint", "milk"]);
    await expectMatches({ blocked: "0" }, ["report", "tap", "pct", "pctDecoy", "under", "underDecoy", "slash"]);
    await expectMatches({ blocked: "0", status: "all" }, [
      "report",
      "tap",
      "pct",
      "pctDecoy",
      "under",
      "underDecoy",
      "slash",
      "taxes",
      "gym",
    ]);
  });

  it("filters by estimate", async () => {
    await expectMatches({ estimate: "1" }, ["milk", "report", "paint", "under"]);
    await expectMatches({ estimate: "0" }, ["tap", "pct", "pctDecoy", "underDecoy", "slash"]);
  });

  it("ANDs combined filters", async () => {
    await expectMatches({ q: "milk", project: "inbox", priority: "1", due: "overdue", blocked: "1" }, ["milk"]);
    await expectMatches({ q: "MILK", project: "inbox", priority: "1", due: "overdue", blocked: "1", estimate: "1" }, ["milk"]);
    await expectMatches({ q: "milk", project: "inbox", priority: "1", due: "overdue", blocked: "0" }, []);
    await expectMatches({ q: "milk", project: home.id, due: "overdue" }, ["tap"]);
    await expectMatches({ q: "milk", blocked: "0" }, ["tap"]);
    await expectMatches({ q: "milk", estimate: "0" }, ["tap"]);
    await expectMatches({ project: work.id, priority: "2", estimate: "1" }, ["report", "under"]);
    await expectMatches({ project: work.id, priority: "2", estimate: "1", due: "has" }, ["report"]);
    await expectMatches({ project: "inbox", due: "has", status: "all" }, ["milk", "taxes", "pct"]);
    await expectMatches({ project: home.id, status: "all", blocked: "0", due: "none" }, ["gym"]);
  });

  it("decides overdue by the user's local date, not UTC", async () => {
    // 12:00 UTC on the 9th is already the 10th in Auckland.
    const now = new Date("2026-03-09T12:00:00Z");
    const auckland = localToday("Pacific/Auckland", now);
    expect(auckland).toBe("2026-03-10");
    expect(localToday("UTC", now)).toBe("2026-03-09");

    // milk is due on the 9th: overdue in Auckland, due today in UTC.
    expect((await search({ due: "overdue" }, auckland)).sort()).toEqual([t.milk!, t.tap!].sort());
    expect(await search({ due: "overdue" }, "2026-03-09")).toEqual([t.tap!]);
    expect(await search({ due: "overdue" }, "2026-03-01")).toEqual([]);
    expect((await search({ due: "overdue" }, "2026-03-11")).sort()).toEqual([t.milk!, t.tap!, t.report!].sort());
  });

  it("orders open first, then priority, deadline (none last), age", async () => {
    expect(await search({ status: "all" })).toEqual(
      ["tap", "milk", "report", "under", "slash", "pct", "paint", "pctDecoy", "underDecoy", "taxes", "gym"].map((k) => t[k]),
    );
  });

  it("attaches subtasks and blockers as the task lists do", async () => {
    const sub = await addSubtask(userId, t.paint!, "Buy brushes");
    const [paint] = (await searchTasks(userId, parseSearchQuery({ q: "paint fence" }), TODAY)).tasks;
    const expected = await getTask(userId, t.paint!);
    expect(paint).toEqual(expected);
    expect(paint!.subtasks.map((s) => s.id)).toEqual([sub.id]);
    expect(paint!.blockers).toEqual([{ id: t.tap, title: "Fix tap", status: "open" }]);
  });

  it(`returns at most ${SEARCH_LIMIT} tasks and says when there were more`, async () => {
    const bulk = await createUser("Bulk");
    const rows = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => ({ userId: bulk, title: `bulk ${i}` }));
    await db.insert(tasks).values(rows);

    const full = await searchTasks(bulk, DEFAULT_SEARCH_QUERY, TODAY);
    expect(full.tasks).toHaveLength(SEARCH_LIMIT);
    expect(full.truncated).toBe(true);

    await db.delete(tasks).where(and(eq(tasks.userId, bulk), eq(tasks.title, "bulk 0")));
    const exact = await searchTasks(bulk, DEFAULT_SEARCH_QUERY, TODAY);
    expect(exact.tasks).toHaveLength(SEARCH_LIMIT);
    expect(exact.truncated).toBe(false);

    const few = await searchTasks(bulk, { ...DEFAULT_SEARCH_QUERY, q: "bulk 19" }, TODAY);
    expect(few.tasks.map((x) => x.title).sort()).toEqual(["bulk 19", ...Array.from({ length: 10 }, (_, i) => `bulk 19${i}`)]);
    expect(few.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The page

/** Props of every element of `component` in a server-rendered tree, in order. */
function propsOf<P>(tree: unknown, component: (props: P) => unknown): P[] {
  const out: P[] = [];
  const seen = new WeakSet<object>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    const el = v as { type?: unknown; props?: unknown };
    if (el.type === component) out.push(el.props as P);
    for (const [key, child] of Object.entries(v)) if (!key.startsWith("_")) visit(child);
  };
  visit(tree);
  return out;
}

type RowProps = { task: TaskView; projectLabel?: string };
type FilterProps = { query: SearchQuery; projects: { id: string; name: string }[] };

const render = (params: SearchParamsInput) => SearchPage({ searchParams: Promise.resolve(params) });
const rows = (tree: unknown) => propsOf<RowProps>(tree, TaskRow as (p: RowProps) => unknown);
const filters = (tree: unknown) => propsOf<FilterProps>(tree, SearchFilters as (p: FilterProps) => unknown)[0]!;
const textIn = (tree: unknown) => stringsIn(tree).join("\n");

describe("the /search page", () => {
  let userId: string;
  let home: Project;
  let old: Project;
  let ids: Record<"milk" | "tap" | "done" | "overdue", string>;

  beforeEach(async () => {
    await resetDb();
    userId = await signIn("ada@example.com");
    home = await createProject(userId, { name: "Home" });
    old = await createProject(userId, { name: "Old" });
    await setProjectArchived(userId, old.id, true);
    ids = {
      milk: (await createTask(userId, { title: "Buy milk" })).id,
      tap: await seedTask(userId, { title: "Fix tap", project: home, priority: 1, description: "milk jug" }),
      done: await seedTask(userId, { title: "Old milk run", project: old, status: "done" }),
      overdue: await seedTask(userId, { title: "Renew passport", deadline: "2000-01-01" }),
    };
  });

  it("requires a signed-in user", async () => {
    actAs(null);
    await expect(render({})).rejects.toThrow("REDIRECT:/login");
  });

  it("lists matching tasks with their project, a count and the parsed filters", async () => {
    const tree = await render({ q: "  MILK ", status: "all" });

    expect(rows(tree).map((r) => [r.task.id, r.projectLabel])).toEqual([
      [ids.tap, "Home"],
      [ids.milk, "Inbox"],
      [ids.done, "Old"],
    ]);
    expect(filters(tree).query).toEqual({ ...DEFAULT_SEARCH_QUERY, q: "MILK", status: "all" });
    expect(filters(tree).projects).toEqual([
      { id: home.id, name: "Home" },
      { id: old.id, name: "Old (archived)" },
    ]);
    expect(textIn(tree)).toContain("3 tasks");
    expect(textIn(tree)).toContain("Clear filters");
  });

  it("uses the user's today for overdue", async () => {
    const tree = await render({ due: "overdue" });
    expect(rows(tree).map((r) => r.task.id)).toEqual([ids.overdue]);
    expect(textIn(tree)).toContain("1 task");
  });

  it("shows the empty state, and no Clear link without filters", async () => {
    const empty = await render({ q: "nothing like this" });
    expect(rows(empty)).toEqual([]);
    expect(textIn(empty)).toContain("No tasks match.");

    const unfiltered = await render({});
    expect(rows(unfiltered)).toHaveLength(3);
    expect(textIn(unfiltered)).not.toContain("Clear filters");
  });

  it("an unknown project id shows no tasks and falls back to All projects", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const tree = await render({ project: missing, q: "milk" });
    expect(rows(tree)).toEqual([]);
    expect(textIn(tree)).toContain("No tasks match.");
    expect(filters(tree).query).toEqual({ ...DEFAULT_SEARCH_QUERY, q: "milk" });
    expect(textIn(tree)).not.toContain(missing);
    // Still filtering, so the way back is offered.
    expect(textIn(tree)).toContain("Clear filters");
  });

  it("drops invalid params instead of failing", async () => {
    const tree = await render({ project: "nope", priority: "9", status: ["bogus"], due: "soon", blocked: "maybe" });
    expect(filters(tree).query).toEqual(DEFAULT_SEARCH_QUERY);
    expect(rows(tree)).toHaveLength(3);
  });

  it(`notes when only the first ${SEARCH_LIMIT} results are shown`, async () => {
    const rowsToAdd = Array.from({ length: SEARCH_LIMIT }, (_, i) => ({ userId, title: `bulk ${i}` }));
    await db.insert(tasks).values(rowsToAdd);
    const tree = await render({});
    expect(rows(tree)).toHaveLength(SEARCH_LIMIT);
    expect(textIn(tree)).toContain(`Showing the first ${SEARCH_LIMIT} results, narrow your search`);
  });
});
