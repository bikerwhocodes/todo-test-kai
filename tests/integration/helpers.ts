import { randomUUID } from "node:crypto";
import { afterAll, inject } from "vitest";
import { createDb } from "../../src/server/db/client";
import { users } from "../../src/server/db/schema";

export function useTestDb() {
  const { db, pool } = createDb(inject("testDatabaseUrl"));
  afterAll(() => pool.end());
  return { db, pool };
}

export async function createUser(db: ReturnType<typeof useTestDb>["db"]): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, name: "Test user", email: `${id}@example.test` });
  return id;
}

/** Runs `fn` and returns the Postgres error it raised (unwrapping Drizzle's wrapper). */
export async function pgErrorOf(fn: () => Promise<unknown>): Promise<{ code: string; constraint?: string }> {
  try {
    await fn();
  } catch (err) {
    for (let e: any = err; e; e = e.cause) {
      if (typeof e.code === "string") return e;
    }
    throw err;
  }
  throw new Error("expected a database error, but the statement succeeded");
}
