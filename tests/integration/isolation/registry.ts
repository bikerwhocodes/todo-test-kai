import type * as authActions from "@/server/actions/auth";
import type * as planActions from "@/server/actions/plans";
import type * as projectActions from "@/server/actions/projects";
import type * as seriesActions from "@/server/actions/series";
import type * as settingsActions from "@/server/actions/settings";
import type * as taskActions from "@/server/actions/tasks";
import type { World } from "./world";

/*
 * Account isolation registry: the single list of everything one user could use to reach
 * another user's data. coverage.test.ts fails the build when the code has a user-owned
 * table, server action, route handler or page that is not listed here, and the other tests
 * in this folder run a cross-user case for every entry.
 *
 * Definition of done for any story that adds one of these: register it here (with a case,
 * or an exemption that says why none is needed) and seed it in ./world.ts.
 */

// ---------------------------------------------------------------------------------------
// Tables

/**
 * Tables holding rows that belong to one user, keyed by the column naming the owner.
 * snapshotOf() reads all of A's rows from every table here; each cross-user case asserts
 * that snapshot is identical before and after. Every public table with a `user_id` column
 * must be listed.
 */
export const USER_OWNED_TABLES: Record<string, { ownerColumn: string }> = {
  users: { ownerColumn: "id" },
  sessions: { ownerColumn: "user_id" },
  accounts: { ownerColumn: "user_id" },
  user_settings: { ownerColumn: "user_id" },
  projects: { ownerColumn: "user_id" },
  recurring_series: { ownerColumn: "user_id" },
  tasks: { ownerColumn: "user_id" },
  subtasks: { ownerColumn: "user_id" },
  task_dependencies: { ownerColumn: "user_id" },
  day_plans: { ownerColumn: "user_id" },
  plan_items: { ownerColumn: "user_id" },
  plan_dismissals: { ownerColumn: "user_id" },
};

/** Public tables that belong to no user, with the reason. */
export const SHARED_TABLES: Record<string, string> = {
  verifications: "Better Auth one-time tokens keyed by identifier; no user_id and nothing in the app reads them.",
  rate_limits: "Auth rate-limit counters keyed by client IP and path, not by user.",
};

// ---------------------------------------------------------------------------------------
// Server actions (every export of a "use server" module in src/server/actions)

export type ActionName =
  | keyof typeof taskActions
  | keyof typeof projectActions
  | keyof typeof seriesActions
  | keyof typeof planActions
  | keyof typeof settingsActions
  | keyof typeof authActions;

export type NotFound = "Task not found" | "Project not found" | "Subtask not found" | "Series not found";

export type ActionCase = {
  /** What B tries to do, e.g. "rename A's project". */
  name: string;
  /** The action's input, built from the seeded world (B is signed in). */
  input: (w: World) => unknown;
  /** The not-found error B must get back. */
  error: NotFound;
};

const DAILY_RULE = { kind: "daily", interval: 1, startDate: "2026-01-01" };

export type ActionCoverage =
  | { cases: [ActionCase, ...ActionCase[]] }
  /** Takes no resource id; actions.test.ts must still prove it only touches the caller's data. */
  | { exempt: string };

export const ACTION_COVERAGE: Record<ActionName, ActionCoverage> = {
  // src/server/actions/tasks.ts
  createTaskAction: {
    cases: [
      { name: "create a task in A's project", input: (w) => ({ title: "x", projectId: w.a.project.id }), error: "Project not found" },
      {
        name: "create a task in A's archived project",
        input: (w) => ({ title: "x", projectId: w.a.archivedProject.id }),
        error: "Project not found",
      },
    ],
  },
  updateTaskAction: {
    cases: [
      { name: "retitle A's inbox task", input: (w) => ({ id: w.a.inboxTask.id, title: "pwned" }), error: "Task not found" },
      {
        name: "edit every field of A's project task",
        input: (w) => ({
          id: w.a.projectTask.id,
          title: "pwned",
          description: "pwned",
          priority: 2,
          deadline: "2030-01-01",
          estimateMin: 5,
        }),
        error: "Task not found",
      },
      {
        name: "clear A's optional fields with null",
        input: (w) => ({ id: w.a.projectTask.id, description: null, priority: null, deadline: null, estimateMin: null }),
        error: "Task not found",
      },
      { name: "edit A's completed task", input: (w) => ({ id: w.a.completedTask.id, title: "pwned" }), error: "Task not found" },
      { name: "send an empty patch for A's task", input: (w) => ({ id: w.a.inboxTask.id }), error: "Task not found" },
      {
        name: "move A's task into B's project",
        input: (w) => ({ id: w.a.projectTask.id, projectId: w.b.project.id }),
        error: "Task not found",
      },
      {
        name: "move A's task within A's projects",
        input: (w) => ({ id: w.a.inboxTask.id, projectId: w.a.project.id }),
        error: "Task not found",
      },
      { name: "move A's task to the Inbox", input: (w) => ({ id: w.a.projectTask.id, projectId: null }), error: "Task not found" },
      {
        name: "move B's own task into A's project",
        input: (w) => ({ id: w.b.inboxTask.id, projectId: w.a.project.id }),
        error: "Project not found",
      },
      {
        name: "move B's own task into A's archived project",
        input: (w) => ({ id: w.b.projectTask.id, projectId: w.a.archivedProject.id }),
        error: "Project not found",
      },
      { name: "retitle A's open occurrence", input: (w) => ({ id: w.a.occurrence.id, title: "pwned" }), error: "Task not found" },
      {
        name: "edit A's completed occurrence",
        input: (w) => ({ id: w.a.completedOccurrence.id, deadline: "2030-01-01" }),
        error: "Task not found",
      },
    ],
  },
  setTaskCompletedAction: {
    cases: [
      { name: "complete A's open task", input: (w) => ({ id: w.a.inboxTask.id, completed: true }), error: "Task not found" },
      { name: "reopen A's completed task", input: (w) => ({ id: w.a.completedTask.id, completed: false }), error: "Task not found" },
      {
        name: "re-complete A's completed task",
        input: (w) => ({ id: w.a.completedTask.id, completed: true }),
        error: "Task not found",
      },
      // Occurrences go through the series rules (locks, next occurrence, reopen checks).
      { name: "complete A's open occurrence", input: (w) => ({ id: w.a.occurrence.id, completed: true }), error: "Task not found" },
      {
        name: "re-complete A's completed occurrence",
        input: (w) => ({ id: w.a.completedOccurrence.id, completed: true }),
        error: "Task not found",
      },
      {
        name: "reopen A's completed occurrence",
        input: (w) => ({ id: w.a.completedOccurrence.id, completed: false }),
        error: "Task not found",
      },
      { name: "reopen A's open occurrence", input: (w) => ({ id: w.a.occurrence.id, completed: false }), error: "Task not found" },
    ],
  },
  deleteTaskAction: {
    cases: [
      { name: "delete A's inbox task", input: (w) => ({ id: w.a.inboxTask.id }), error: "Task not found" },
      { name: "delete A's task that has subtasks", input: (w) => ({ id: w.a.projectTask.id }), error: "Task not found" },
      { name: "delete A's completed task", input: (w) => ({ id: w.a.completedTask.id }), error: "Task not found" },
      // Deleting one's own occurrence is a conflict; for A's it must still be not-found.
      { name: "delete A's open occurrence", input: (w) => ({ id: w.a.occurrence.id }), error: "Task not found" },
    ],
  },
  addSubtaskAction: {
    cases: [
      { name: "add a subtask to A's task", input: (w) => ({ taskId: w.a.projectTask.id, title: "x" }), error: "Task not found" },
      { name: "add a subtask to A's completed task", input: (w) => ({ taskId: w.a.completedTask.id, title: "x" }), error: "Task not found" },
    ],
  },
  updateSubtaskAction: {
    cases: [
      { name: "tick A's subtask", input: (w) => ({ id: w.a.subtask.id, done: true }), error: "Subtask not found" },
      { name: "retitle A's subtask", input: (w) => ({ id: w.a.subtask.id, title: "pwned" }), error: "Subtask not found" },
      // An empty patch reads the row back instead of updating it; that read must be scoped too.
      { name: "read A's subtask through an empty patch", input: (w) => ({ id: w.a.subtask.id }), error: "Subtask not found" },
    ],
  },
  deleteSubtaskAction: {
    cases: [{ name: "delete A's subtask", input: (w) => ({ id: w.a.subtask.id }), error: "Subtask not found" }],
  },
  addBlockerAction: {
    cases: [
      {
        name: "make A's task wait on another of A's tasks",
        input: (w) => ({ taskId: w.a.inboxTask.id, blockedByTaskId: w.a.completedTask.id }),
        error: "Task not found",
      },
      // Ownership is checked before the cycle check, so B can't learn A's graph from a loop message.
      {
        name: "close a loop in A's graph",
        input: (w) => ({ taskId: w.a.inboxTask.id, blockedByTaskId: w.a.projectTask.id }),
        error: "Task not found",
      },
      {
        name: "re-add A's existing link",
        input: (w) => ({ taskId: w.a.projectTask.id, blockedByTaskId: w.a.inboxTask.id }),
        error: "Task not found",
      },
      {
        name: "make A's task wait on itself",
        input: (w) => ({ taskId: w.a.inboxTask.id, blockedByTaskId: w.a.inboxTask.id }),
        error: "Task not found",
      },
      {
        name: "make B's own task wait on A's task",
        input: (w) => ({ taskId: w.b.inboxTask.id, blockedByTaskId: w.a.inboxTask.id }),
        error: "Task not found",
      },
      {
        name: "make A's task wait on B's own task",
        input: (w) => ({ taskId: w.a.inboxTask.id, blockedByTaskId: w.b.inboxTask.id }),
        error: "Task not found",
      },
    ],
  },
  removeBlockerAction: {
    cases: [
      {
        name: "remove A's link",
        input: (w) => ({ taskId: w.a.projectTask.id, blockedByTaskId: w.a.inboxTask.id }),
        error: "Task not found",
      },
      {
        name: "remove a link between B's task and A's task",
        input: (w) => ({ taskId: w.b.projectTask.id, blockedByTaskId: w.a.inboxTask.id }),
        error: "Task not found",
      },
      {
        name: "remove a link between A's task and B's task",
        input: (w) => ({ taskId: w.a.projectTask.id, blockedByTaskId: w.b.inboxTask.id }),
        error: "Task not found",
      },
    ],
  },

  // src/server/actions/projects.ts
  createProjectAction: {
    exempt: "Takes no resource id. actions.test.ts checks it writes to the caller's account even when sent A's userId.",
  },
  renameProjectAction: {
    cases: [
      { name: "rename A's project", input: (w) => ({ id: w.a.project.id, name: "pwned" }), error: "Project not found" },
      { name: "rename A's archived project", input: (w) => ({ id: w.a.archivedProject.id, name: "pwned" }), error: "Project not found" },
    ],
  },
  setProjectArchivedAction: {
    cases: [
      { name: "archive A's project", input: (w) => ({ id: w.a.project.id, archived: true }), error: "Project not found" },
      { name: "unarchive A's archived project", input: (w) => ({ id: w.a.archivedProject.id, archived: false }), error: "Project not found" },
      { name: "re-archive A's archived project", input: (w) => ({ id: w.a.archivedProject.id, archived: true }), error: "Project not found" },
    ],
  },

  // src/server/actions/series.ts
  createSeriesAction: {
    cases: [
      {
        name: "create a series in A's project",
        input: (w) => ({ title: "x", projectId: w.a.project.id, rule: DAILY_RULE }),
        error: "Project not found",
      },
      {
        name: "create a series in A's archived project",
        input: (w) => ({ title: "x", projectId: w.a.archivedProject.id, rule: DAILY_RULE }),
        error: "Project not found",
      },
    ],
  },
  updateSeriesAction: {
    cases: [
      { name: "retitle A's series", input: (w) => ({ id: w.a.series.id, title: "pwned" }), error: "Series not found" },
      {
        name: "edit every template field and the rule of A's series",
        input: (w) => ({
          id: w.a.series.id,
          title: "pwned",
          description: "pwned",
          priority: 1,
          estimateMin: 5,
          rule: { kind: "weekly", interval: 2, weekdays: [1, 3], startDate: "2026-01-01", endDate: "2030-01-01" },
        }),
        error: "Series not found",
      },
      {
        name: "clear A's optional template fields with null",
        input: (w) => ({ id: w.a.series.id, description: null, priority: null, estimateMin: null, projectId: null }),
        error: "Series not found",
      },
      { name: "send an empty patch for A's series", input: (w) => ({ id: w.a.series.id }), error: "Series not found" },
      {
        name: "move A's series into B's project",
        input: (w) => ({ id: w.a.series.id, projectId: w.b.project.id }),
        error: "Series not found",
      },
      {
        name: "move B's own series into A's project",
        input: (w) => ({ id: w.b.series.id, projectId: w.a.project.id }),
        error: "Project not found",
      },
      {
        name: "move B's own series into A's archived project",
        input: (w) => ({ id: w.b.series.id, projectId: w.a.archivedProject.id }),
        error: "Project not found",
      },
      // An occurrence id is not a series id, whoever owns it.
      { name: "use A's occurrence id as a series id", input: (w) => ({ id: w.a.occurrence.id, title: "pwned" }), error: "Series not found" },
    ],
  },
  deleteSeriesAction: {
    cases: [
      { name: "delete A's series", input: (w) => ({ id: w.a.series.id }), error: "Series not found" },
      { name: "use A's occurrence id as a series id", input: (w) => ({ id: w.a.occurrence.id }), error: "Series not found" },
    ],
  },
  skipOccurrenceAction: {
    cases: [
      { name: "skip A's open occurrence", input: (w) => ({ id: w.a.occurrence.id }), error: "Task not found" },
      { name: "skip A's completed occurrence", input: (w) => ({ id: w.a.completedOccurrence.id }), error: "Task not found" },
      // A one-off task of one's own is a conflict; A's must be not-found, not a hint it exists.
      { name: "skip A's one-off task", input: (w) => ({ id: w.a.inboxTask.id }), error: "Task not found" },
    ],
  },

  // src/server/actions/plans.ts. Each works on B's own today; ownership is checked before
  // anything else, so A's done, planned or dismissed tasks get the same answer as missing ones.
  suggestPlanAction: {
    exempt:
      "Takes no resource id and saves nothing. actions.test.ts checks B's draft holds none of A's tasks, even with a smuggled userId.",
  },
  acceptPlanAction: {
    cases: [
      { name: "accept A's task into B's plan", input: (w) => ({ taskIds: [w.a.dueTask.id] }), error: "Task not found" },
      {
        name: "accept A's planned task, with available time",
        input: (w) => ({ taskIds: [w.a.inboxTask.id], availableMin: 30 }),
        error: "Task not found",
      },
      // A not-open task of one's own is a conflict; A's must be not-found.
      { name: "accept A's completed task", input: (w) => ({ taskIds: [w.a.completedTask.id] }), error: "Task not found" },
      {
        name: "accept B's own task together with A's",
        input: (w) => ({ taskIds: [w.b.dueTask.id, w.a.projectTask.id] }),
        error: "Task not found",
      },
      {
        name: "accept B's own planned task together with A's",
        input: (w) => ({ taskIds: [w.b.inboxTask.id, w.a.occurrence.id] }),
        error: "Task not found",
      },
    ],
  },
  addPlanItemAction: {
    cases: [
      { name: "add A's task to B's plan", input: (w) => ({ taskId: w.a.dueTask.id }), error: "Task not found" },
      { name: "add A's planned task", input: (w) => ({ taskId: w.a.inboxTask.id }), error: "Task not found" },
      // Adding undoes a dismissal; A's must stay.
      { name: "add A's dismissed task", input: (w) => ({ taskId: w.a.upcomingTask.id }), error: "Task not found" },
      { name: "add A's completed task", input: (w) => ({ taskId: w.a.completedTask.id }), error: "Task not found" },
    ],
  },
  removePlanItemAction: {
    cases: [
      { name: "remove A's planned task", input: (w) => ({ taskId: w.a.inboxTask.id }), error: "Task not found" },
      { name: "remove A's unplanned task", input: (w) => ({ taskId: w.a.dueTask.id }), error: "Task not found" },
    ],
  },
  reorderPlanAction: {
    cases: [
      { name: "reorder with A's plan", input: (w) => ({ taskIds: [w.a.inboxTask.id] }), error: "Task not found" },
      {
        name: "reorder B's plan with A's task added",
        input: (w) => ({ taskIds: [w.a.inboxTask.id, w.b.inboxTask.id] }),
        error: "Task not found",
      },
      {
        name: "reorder B's plan with A's task in place of B's",
        input: (w) => ({ taskIds: [w.a.dueTask.id] }),
        error: "Task not found",
      },
    ],
  },
  dismissSuggestionAction: {
    cases: [
      { name: "dismiss A's task", input: (w) => ({ taskId: w.a.dueTask.id }), error: "Task not found" },
      { name: "re-dismiss A's dismissed task", input: (w) => ({ taskId: w.a.upcomingTask.id }), error: "Task not found" },
      { name: "dismiss A's planned task", input: (w) => ({ taskId: w.a.inboxTask.id }), error: "Task not found" },
    ],
  },

  // src/server/actions/settings.ts
  updateSettingsAction: {
    exempt:
      "Takes no resource id; writes the caller's own user_settings row. actions.test.ts checks a smuggled userId is ignored.",
  },
  rememberAvailableTimeAction: {
    exempt:
      "Takes no resource id; writes only the caller's own user_settings.last_available_min. actions.test.ts checks a smuggled userId is ignored.",
  },

  // src/server/actions/auth.ts
  signOutAction: {
    exempt: "Takes no input and ends the caller's own session. actions.test.ts checks A stays signed in when B signs out.",
  },
};

// ---------------------------------------------------------------------------------------
// Route handlers (src/app/**/route.ts) and pages/layouts (src/app/**/{page,layout}.tsx)

/**
 * `cases`: covered in routes.test.ts / pages.test.ts, whose case tables are typed so that a
 * covered file without cases does not compile. `exempt`: why no user data is reachable.
 * Keys are repo-relative paths.
 */
export type FileCoverage = { cases: string } | { exempt: string };

export const ROUTE_COVERAGE = {
  "src/app/api/auth/[...all]/route.ts": {
    cases: "Better Auth endpoints that read or act on sessions and users: get-session, list-sessions, revoke-session(s), update-user.",
  },
} as const satisfies Record<string, FileCoverage>;

export const PAGE_COVERAGE = {
  "src/app/layout.tsx": { exempt: "Root HTML shell; reads no data." },
  "src/app/page.tsx": { exempt: "requireUser() then redirect('/today'); reads no data." },
  "src/app/(auth)/layout.tsx": { exempt: "Only checks whether there is a session, then redirects." },
  "src/app/(auth)/login/page.tsx": { exempt: "Signed-out form; reads no data." },
  "src/app/(auth)/signup/page.tsx": { exempt: "Signed-out form; reads no data." },
  "src/app/(app)/layout.tsx": { cases: "Nav lists only the caller's projects and email." },
  "src/app/(app)/today/page.tsx": { cases: "Shows the caller's own time zone, plan and due tasks." },
  "src/app/(app)/upcoming/page.tsx": {
    cases: "Lists only the caller's tasks and occurrences with deadlines, grouped in the caller's zone.",
  },
  "src/app/(app)/inbox/page.tsx": {
    cases: "Lists only the caller's inbox tasks, their blockers, and the caller's projects and open tasks to pick from.",
  },
  "src/app/(app)/projects/[id]/page.tsx": {
    cases: "Another user's project id is a 404; own page shows only own data, blockers and picker options.",
  },
  "src/app/(app)/projects/archived/page.tsx": { cases: "Lists only the caller's archived projects." },
  "src/app/(app)/search/page.tsx": {
    cases: "Searches only the caller's tasks and offers only the caller's projects; another user's project id matches nothing and isn't echoed back.",
  },
  "src/app/(app)/recurring/page.tsx": { cases: "Lists only the caller's recurring series." },
  "src/app/(app)/recurring/[id]/page.tsx": { cases: "Another user's series id is a 404; own page shows only own data." },
  "src/app/(app)/settings/page.tsx": { cases: "Shows only the caller's own zone and default estimate." },
} as const satisfies Record<string, FileCoverage>;

type CoveredKeys<T> = { [K in keyof T]: T[K] extends { cases: string } ? K : never }[keyof T];
export type CoveredRoute = CoveredKeys<typeof ROUTE_COVERAGE>;
export type CoveredPage = CoveredKeys<typeof PAGE_COVERAGE>;

/** One cross-user check. Runs after seedWorld(), signed out; sign in with actAs(). */
export type FileCase = [name: string, run: (w: World) => Promise<void>];
export type FileCases<K extends string> = Record<K, [FileCase, ...FileCase[]]>;
