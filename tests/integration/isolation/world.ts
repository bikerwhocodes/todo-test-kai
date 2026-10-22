import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { db } from "@/server/db";
import { session, taskDependencies, type Project, type Subtask, type Task, type TaskDependency } from "@/server/db/schema";
import { addBlocker } from "@/server/repo/dependencies";
import { createProject, setProjectArchived } from "@/server/repo/projects";
import { addSubtask } from "@/server/repo/subtasks";
import { createTask, setTaskCompleted, updateTask } from "@/server/repo/tasks";
import { resetDb } from "../helpers";
import { signUp, type SignedUp } from "../session-helpers";
import { USER_OWNED_TABLES } from "./registry";

// Two real, signed-up users that each own one of everything. Tests sign in as B and aim
// at A's ids. Import only from test files that mock Next.js with ../next-mocks.

export type Account = SignedUp & {
  /** Appears in every name/title this user owns, so leaks are easy to spot. */
  marker: string;
  timeZone: string;
  /** Raw token of the session created at signup (`sessions.token`). */
  sessionToken: string;
  project: Project;
  archivedProject: Project;
  inboxTask: Task;
  projectTask: Task;
  completedTask: Task;
  archivedProjectTask: Task;
  subtask: Subtask;
  /** projectTask is blocked by inboxTask (both open, so projectTask shows "Waiting on"). */
  dependency: TaskDependency;
};

export type World = { a: Account; b: Account };

/**
 * Empties the database and seeds A and B. When you add a user-owned table, seed a row of it
 * for each user here; the coverage suite fails while A owns no row in a registered table.
 */
export async function seedWorld(): Promise<World> {
  await resetDb();
  const a = await seedAccount("alice", "ALICE-ONLY", "Asia/Tokyo");
  const b = await seedAccount("bob", "BOB-OWN", "America/Toronto");
  return { a, b };
}

async function seedAccount(slug: string, marker: string, timeZone: string): Promise<Account> {
  const user = await signUp(`${slug}@example.com`, { name: `${marker} user`, timeZone });
  const [sessionRow] = await db.select({ token: session.token }).from(session).where(eq(session.userId, user.id));
  if (!sessionRow) throw new Error(`no session row for ${slug}`);

  const project = await createProject(user.id, { name: `${marker} project` });
  let archivedProject = await createProject(user.id, { name: `${marker} archived project` });
  const archivedProjectTask = await createTask(user.id, {
    title: `${marker} task in archived project`,
    projectId: archivedProject.id,
  });
  archivedProject = await setProjectArchived(user.id, archivedProject.id, true);

  const inboxTask = await createTask(user.id, { title: `${marker} inbox task` });
  let projectTask = await createTask(user.id, { title: `${marker} project task`, projectId: project.id });
  projectTask = await updateTask(user.id, projectTask.id, {
    description: `${marker} description`,
    priority: 1,
    deadline: "2026-11-05",
    estimateMin: 25,
  });
  let completedTask = await createTask(user.id, { title: `${marker} completed task` });
  completedTask = await setTaskCompleted(user.id, completedTask.id, true);
  const subtask = await addSubtask(user.id, projectTask.id, `${marker} subtask`);
  await addBlocker(user.id, projectTask.id, inboxTask.id);
  const [dependency] = await db.select().from(taskDependencies).where(eq(taskDependencies.userId, user.id));
  if (!dependency) throw new Error(`no task_dependencies row for ${slug}`);

  return {
    ...user,
    marker,
    timeZone,
    sessionToken: sessionRow.token,
    project,
    archivedProject,
    inboxTask,
    projectTask,
    completedTask,
    archivedProjectTask,
    subtask,
    dependency,
  };
}

export type Snapshot = Record<string, string[]>;

/**
 * Every row `userId` owns in every table of USER_OWNED_TABLES, as canonical JSON text.
 * Two snapshots are equal only if nothing of that user's was inserted, changed or deleted.
 */
export async function snapshotOf(userId: string, { except = [] as string[] } = {}): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for (const [table, { ownerColumn }] of Object.entries(USER_OWNED_TABLES)) {
    if (except.includes(table)) continue;
    const rows = await db.execute<{ data: string }>(
      sql`select to_jsonb(t)::text as data from ${sql.identifier(table)} t where t.${sql.identifier(ownerColumn)} = ${userId} order by 1`,
    );
    snapshot[table] = Array.from(rows, (r) => r.data);
  }
  return snapshot;
}

/** Strings that identify `account`'s data; none may show up in what another user sees. */
export function fingerprints(account: Account): string[] {
  return [
    account.id,
    account.email,
    account.marker,
    account.timeZone,
    account.sessionToken,
    account.project.id,
    account.archivedProject.id,
    account.inboxTask.id,
    account.projectTask.id,
    account.completedTask.id,
    account.archivedProjectTask.id,
    account.subtask.id,
  ];
}

/** Every string (and Date, as ISO) reachable from `value`: props of a React element tree, JSON, ... */
export function stringsIn(value: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "bigint") out.push(String(v));
    else if (v instanceof Date) out.push(v.toISOString());
    else if (v && typeof v === "object") {
      if (seen.has(v)) return;
      seen.add(v);
      for (const [key, child] of Object.entries(v)) {
        // React dev-only bookkeeping (_owner, _debugStack, ...), not data.
        if (key.startsWith("_")) continue;
        visit(child);
      }
    }
  };
  visit(value);
  return out;
}

/** Fails if anything identifying `owner` appears in `value` (what someone else was shown). */
export function expectNoneOf(owner: Account, value: unknown) {
  const strings = stringsIn(value);
  for (const print of fingerprints(owner)) {
    const hit = strings.find((s) => s.includes(print));
    expect(hit, `leaked "${print}" (belongs to ${owner.email})`).toBeUndefined();
  }
}

/** Positive control, so a "no leak" assertion can't pass just because nothing was rendered. */
export function expectSomeOf(owner: Account, value: unknown, ...prints: string[]) {
  const strings = stringsIn(value);
  for (const print of prints) {
    expect(
      strings.some((s) => s.includes(print)),
      `expected ${owner.email}'s own "${print}" in the output`,
    ).toBe(true);
  }
}
