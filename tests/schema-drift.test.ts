// Migrations are hand-written SQL and db/schema.ts is a separate, hand-written
// Drizzle mirror of them. Nothing in the toolchain forces those two to agree,
// so this test does: a column added to one and forgotten in the other fails
// here instead of surfacing as a confusing runtime type error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.ts";
import { superPool } from "./helpers.ts";

type LiveColumn = { table_name: string; column_name: string; is_nullable: string; data_type: string };

test("db/schema.ts and the live database agree on tables and columns", async () => {
  const { rows } = await superPool.query<LiveColumn>(
    `SELECT table_name, column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`);

  const live = new Map<string, Map<string, LiveColumn>>();
  for (const r of rows) {
    if (!live.has(r.table_name)) live.set(r.table_name, new Map());
    live.get(r.table_name)!.set(r.column_name, r);
  }

  const problems: string[] = [];

  for (const value of Object.values(schema)) {
    // Only the pgTable exports carry a table config.
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      continue;
    }

    const liveTable = live.get(config.name);
    if (!liveTable) {
      problems.push(`table "${config.name}" is declared in db/schema.ts but not in the database`);
      continue;
    }

    for (const col of config.columns) {
      const liveCol = liveTable.get(col.name);
      if (!liveCol) {
        problems.push(`${config.name}.${col.name} is in db/schema.ts but not in the database`);
        continue;
      }
      const liveNotNull = liveCol.is_nullable === "NO";
      if (col.notNull !== liveNotNull) {
        problems.push(
          `${config.name}.${col.name} nullability differs: schema.ts notNull=${col.notNull}, ` +
          `database notNull=${liveNotNull}`);
      }
    }

    for (const liveName of liveTable.keys()) {
      if (!config.columns.some((c) => c.name === liveName)) {
        problems.push(`${config.name}.${liveName} exists in the database but not in db/schema.ts`);
      }
    }
    live.delete(config.name);
  }

  for (const leftover of live.keys()) {
    problems.push(`table "${leftover}" exists in the database but not in db/schema.ts`);
  }

  assert.deepEqual(problems, [], `schema drift:\n  ${problems.join("\n  ")}`);
});

test("calendar dates are `date` and audit instants are `timestamptz` — never swapped", async () => {
  const { rows } = await superPool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public'
        AND (column_name LIKE '%_date' OR column_name = 'deadline'
             OR column_name LIKE '%_at')`);

  const wrong = rows.filter((r) => {
    const isCalendar = r.column_name === "deadline" || r.column_name.endsWith("_date");
    return isCalendar
      ? r.data_type !== "date"
      : r.data_type !== "timestamp with time zone";
  });

  assert.deepEqual(wrong, [],
    "a calendar date stored as a timestamp (or an instant stored as a date) reintroduces " +
    "the off-by-one-day bug the model exists to prevent");
});
