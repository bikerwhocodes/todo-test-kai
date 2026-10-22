import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { createDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/** Creates a throwaway database, migrates it from empty, and drops it afterwards. */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    const message =
      "Integration tests need DATABASE_URL pointing at a Postgres server (role must be able to CREATE DATABASE).";
    // Logged as well because Vitest can fail to print errors thrown from global setup.
    console.error(message);
    throw new Error(message);
  }
  const dbName = `nextup_test_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const teardown = async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  };

  const { db, pool } = createDb(url.toString());
  try {
    await runMigrations(db);
  } catch (err) {
    await pool.end();
    await teardown();
    throw err;
  }
  await pool.end();
  project.provide("testDatabaseUrl", url.toString());

  return teardown;
}
