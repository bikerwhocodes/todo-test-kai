import type * as authActions from "@/server/actions/auth";
import type * as projectActions from "@/server/actions/projects";
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
  tasks: { ownerColumn: "user_id" },
  subtasks: { ownerColumn: "user_id" },
};

/** Public tables that belong to no user, with the reason. */
export const SHARED_TABLES: Record<string, string> = {
  verifications: "Better Auth one-time tokens keyed by identifier; no user_id and nothing in the app reads them.",
  rate_limits: "Auth rate-limit counters keyed by client IP and path, not by user.",
};

// ---------------------------------------------------------------------------------------
// Server actions (every export of a "use server" module in src/server/actions)

export type ActionName = keyof typeof taskActions | keyof typeof projectActions | keyof typeof authActions;

export type NotFound = "Task not found" | "Project not found" | "Subtask not found";

export type ActionCase = {
  /** What B tries to do, e.g. "rename A's project". */
  name: string;
  /** The action's input, built from the seeded world (B is signed in). */
  input: (w: World) => unknown;
  /** The not-found error B must get back. */
  error: NotFound;
};

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
    ],
  },
  deleteTaskAction: {
    cases: [
      { name: "delete A's inbox task", input: (w) => ({ id: w.a.inboxTask.id }), error: "Task not found" },
      { name: "delete A's task that has subtasks", input: (w) => ({ id: w.a.projectTask.id }), error: "Task not found" },
      { name: "delete A's completed task", input: (w) => ({ id: w.a.completedTask.id }), error: "Task not found" },
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
  "src/app/(app)/today/page.tsx": { cases: "Shows the caller's own time zone." },
  "src/app/(app)/inbox/page.tsx": { cases: "Lists only the caller's inbox tasks and projects." },
  "src/app/(app)/projects/[id]/page.tsx": { cases: "Another user's project id is a 404; own page shows only own data." },
  "src/app/(app)/projects/archived/page.tsx": { cases: "Lists only the caller's archived projects." },
} as const satisfies Record<string, FileCoverage>;

type CoveredKeys<T> = { [K in keyof T]: T[K] extends { cases: string } ? K : never }[keyof T];
export type CoveredRoute = CoveredKeys<typeof ROUTE_COVERAGE>;
export type CoveredPage = CoveredKeys<typeof PAGE_COVERAGE>;

/** One cross-user check. Runs after seedWorld(), signed out; sign in with actAs(). */
export type FileCase = [name: string, run: (w: World) => Promise<void>];
export type FileCases<K extends string> = Record<K, [FileCase, ...FileCase[]]>;
