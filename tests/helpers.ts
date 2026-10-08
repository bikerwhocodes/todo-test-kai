// Shared test fixtures.
//
// Role discipline, which the tests depend on being right:
//
//   * FIXTURES use the superuser. Superusers bypass RLS, which is what makes
//     it possible to seed rows for two different accounts in one connection.
//     FORCE ROW LEVEL SECURITY subjects even the table OWNER to its policies,
//     so nextup_owner is not a usable fixture role either.
//
//   * ASSERTIONS about isolation use the RUNTIME role (nextup_runtime) through
//     withUser(). A privilege test that passes as the owner or the superuser
//     proves nothing, so none of them are written that way.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { after } from "node:test";

const url = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run \`npm run db:up && npm run db:setup\``);
  return v;
};

export const superPool = new pg.Pool({ connectionString: url("POSTGRES_SUPERUSER_URL"), max: 5 });
export const runtimePool = new pg.Pool({ connectionString: url("DATABASE_URL"), max: 10 });
export const ownerPool = new pg.Pool({ connectionString: url("MIGRATION_DATABASE_URL"), max: 5 });

after(async () => {
  await Promise.allSettled([superPool.end(), runtimePool.end(), ownerPool.end()]);
});

// A deliberate database restart (tests/persistence.test.ts) severs idle
// clients. Without a handler, that surfaces as an unhandled 'error' event and
// kills the test process rather than failing a test.
for (const p of [superPool, runtimePool, ownerPool]) {
  p.on("error", () => { /* idle client severed; pg will open a fresh one */ });
}

export type TestUser = { id: string; email: string };

/** Seeds a user as the superuser (RLS bypassed) and returns its id. */
export async function makeUser(timezone = "UTC"): Promise<TestUser> {
  const id = randomUUID();
  const email = `u-${id}@example.test`;
  await superPool.query(
    "INSERT INTO users (id, name, email, timezone) VALUES ($1, $2, $3, $4)",
    [id, "Test User", email, timezone],
  );
  return { id, email };
}

/** Seeds two independent accounts — the shape most isolation tests need. */
export async function makeTwoUsers(): Promise<[TestUser, TestUser]> {
  return [await makeUser(), await makeUser()];
}

export async function makeProject(userId: string, name = "Proj"): Promise<string> {
  const { rows } = await superPool.query<{ id: string }>(
    "INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id", [userId, name],
  );
  return rows[0]!.id;
}

export async function makeTask(
  userId: string,
  fields: { title?: string; projectId?: string | null; deadline?: string | null;
            estimateMinutes?: number | null; completedAt?: string | null } = {},
): Promise<string> {
  const { rows } = await superPool.query<{ id: string }>(
    `INSERT INTO tasks (user_id, title, project_id, deadline, estimate_minutes, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, fields.title ?? "Task", fields.projectId ?? null, fields.deadline ?? null,
     fields.estimateMinutes ?? null, fields.completedAt ?? null],
  );
  return rows[0]!.id;
}

export async function makeRule(userId: string, freq = "weekly"): Promise<string> {
  const { rows } = await superPool.query<{ id: string }>(
    "INSERT INTO recurrence_rules (user_id, freq) VALUES ($1, $2) RETURNING id", [userId, freq],
  );
  return rows[0]!.id;
}

/** Captures the Postgres SQLSTATE and constraint name of an expected failure. */
export type DbFailure = { code: string; constraint?: string; message: string };

export async function expectFailure(fn: () => Promise<unknown>): Promise<DbFailure> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message: string };
    return { code: e.code ?? "", constraint: e.constraint, message: e.message };
  }
  throw new Error("expected the operation to fail, but it succeeded");
}
