import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ../next-mocks.
vi.mock("next/headers", async () => (await import("../next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("../next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("../next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("../next-mocks")).reactCache }));

import AppLayout from "@/app/(app)/layout";
import InboxPage from "@/app/(app)/inbox/page";
import ProjectPage, { generateMetadata as projectMetadata } from "@/app/(app)/projects/[id]/page";
import ArchivedProjectsPage from "@/app/(app)/projects/archived/page";
import RecurringPage from "@/app/(app)/recurring/page";
import SeriesPage, { generateMetadata as seriesMetadata } from "@/app/(app)/recurring/[id]/page";
import SettingsPage from "@/app/(app)/settings/page";
import TodayPage from "@/app/(app)/today/page";
import UpcomingPage from "@/app/(app)/upcoming/page";
import { NOT_FOUND, actAs } from "../next-mocks";
import { PAGE_COVERAGE, type CoveredPage, type FileCases } from "./registry";
import { expectNoneOf, expectSomeOf, seedWorld, snapshotOf, type World } from "./world";

// Server-rendered pages, called as B. The element tree a page returns carries every value
// it passes to components as props, so searching it for A's ids and names catches leaks
// without rendering. Pages that take an id must 404 for A's ids.

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const PAGE_CASES: FileCases<CoveredPage> = {
  "src/app/(app)/layout.tsx": [
    [
      "nav shows only B's projects and email",
      async ({ a, b }) => {
        const tree = await AppLayout({ children: null });
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.email, b.project.name);
      },
    ],
  ],
  "src/app/(app)/today/page.tsx": [
    [
      "shows B's time zone, due tasks and due occurrences, not A's",
      async ({ a, b }) => {
        const tree = await TodayPage();
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.timeZone, b.dueTask.title, b.occurrence.title);
      },
    ],
  ],
  "src/app/(app)/inbox/page.tsx": [
    [
      "lists only B's inbox tasks and project options",
      async ({ a, b }) => {
        const tree = await InboxPage();
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.inboxTask.title, b.completedTask.title, b.project.name);
      },
    ],
  ],
  "src/app/(app)/projects/[id]/page.tsx": [
    [
      "A's project ids (and other A ids) are a 404 with a generic title",
      async ({ a }) => {
        for (const id of [a.project.id, a.archivedProject.id, a.projectTask.id]) {
          await expect(ProjectPage(params(id)), `project page for ${id}`).rejects.toThrow(NOT_FOUND);
          expect(await projectMetadata(params(id))).toEqual({ title: "Project · NextUp" });
        }
      },
    ],
    [
      "B's own project page shows only B's data",
      async ({ a, b }) => {
        const tree = await ProjectPage(params(b.project.id));
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.projectTask.title, b.subtask.title, b.project.name);
        const archived = await ProjectPage(params(b.archivedProject.id));
        expectNoneOf(a, archived);
        expectSomeOf(b, archived, b.archivedProjectTask.title);
      },
    ],
  ],
  "src/app/(app)/projects/archived/page.tsx": [
    [
      "lists only B's archived projects",
      async ({ a, b }) => {
        const tree = await ArchivedProjectsPage();
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.archivedProject.name);
      },
    ],
  ],
  "src/app/(app)/recurring/page.tsx": [
    [
      "lists only B's series and project options",
      async ({ a, b }) => {
        const tree = await RecurringPage();
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.series.title, b.series.id, b.project.name);
      },
    ],
  ],
  "src/app/(app)/recurring/[id]/page.tsx": [
    [
      "A's series ids (and other A ids) are a 404 with a generic title",
      async ({ a }) => {
        for (const id of [a.series.id, a.occurrence.id, a.completedOccurrence.id, a.project.id]) {
          await expect(SeriesPage(params(id)), `series page for ${id}`).rejects.toThrow(NOT_FOUND);
          expect(await seriesMetadata(params(id))).toEqual({ title: "Recurring task · NextUp" });
        }
      },
    ],
    [
      "B's own series page shows only B's data",
      async ({ a, b }) => {
        const tree = await SeriesPage(params(b.series.id));
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.series.title, b.series.id, b.project.id);
      },
    ],
  ],
  "src/app/(app)/upcoming/page.tsx": [
    [
      "lists only B's upcoming tasks",
      async ({ a, b }) => {
        const tree = await UpcomingPage();
        expectNoneOf(a, tree);
        expectSomeOf(b, tree, b.timeZone, b.upcomingTask.title, b.upcomingTask.id);
      },
    ],
  ],
  "src/app/(app)/settings/page.tsx": [
    [
      "shows B's settings, not A's",
      async ({ a, b }) => {
        const tree = await SettingsPage();
        // The zone picker lists every IANA zone, A's among them; that is not a leak.
        expectNoneOf(a, tree, { allow: [a.timeZone] });
        expectSomeOf(b, tree, b.timeZone);
        // The selected zone (the form's settings prop) is B's.
        expect(settingsPropsIn(tree)).toEqual([{ timeZone: b.timeZone, defaultEstimateMin: 30 }]);
      },
    ],
  ],
};

/** Every `settings` prop object in a React element tree. */
function settingsPropsIn(tree: unknown): unknown[] {
  const found: unknown[] = [];
  const seen = new WeakSet<object>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    const props = (v as { props?: Record<string, unknown> }).props;
    if (props && "settings" in props) found.push(props.settings);
    for (const [key, child] of Object.entries(v)) if (!key.startsWith("_")) visit(child);
  };
  visit(tree);
  return found;
}

const cases = (Object.keys(PAGE_COVERAGE) as (keyof typeof PAGE_COVERAGE)[]).flatMap((file) => {
  const coverage = PAGE_COVERAGE[file];
  return "cases" in coverage ? PAGE_CASES[file as CoveredPage].map(([name, run]) => [`${file}: ${name}`, run] as const) : [];
});

let w: World;

beforeEach(async () => {
  w = await seedWorld();
  actAs(w.b.cookie);
});

describe("pages signed in as B show none of A's data", () => {
  it.each(cases)("%s", async (_label, run) => {
    const aBefore = await snapshotOf(w.a.id);
    await run(w);
    expect(await snapshotOf(w.a.id)).toEqual(aBefore);
  });
});
