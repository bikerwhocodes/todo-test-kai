import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { db } from "@/server/db";
import { user } from "@/server/db/schema";

/** Empties every table (users cascades to projects, tasks, subtasks, sessions, ...). */
export async function resetDb() {
  await db.execute(sql`truncate users, rate_limits restart identity cascade`);
}

/** Inserts a bare user row; enough for repo-level tests that don't need a session. */
export async function createUser(name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(user).values({ id, name, email: `${name.toLowerCase()}-${id}@example.com` });
  return id;
}

/** Postgres error code, whether postgres-js threw directly or Drizzle wrapped it. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof e?.code === "string" ? e.code : e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export const FK_VIOLATION = "23503";
export const CHECK_VIOLATION = "23514";

export async function expectPgError(query: PromiseLike<unknown>, code: string) {
  const err = await Promise.resolve(query).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "expected the query to fail").not.toBeNull();
  expect(pgCode(err)).toBe(code);
}
