import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ../next-mocks.
vi.mock("next/headers", async () => (await import("../next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("../next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("../next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("../next-mocks")).reactCache }));

import { db } from "@/server/db";
import * as schema from "@/server/db/schema";
import { ACTION_COVERAGE, PAGE_COVERAGE, ROUTE_COVERAGE, SHARED_TABLES, USER_OWNED_TABLES } from "./registry";
import { seedWorld, snapshotOf } from "./world";

// Fails the build when something that can reach user data isn't in ./registry.ts, so
// every new table, server action, route handler and page gets a cross-user test.

const ROOT = process.cwd();
const REGISTRY = "tests/integration/isolation/registry.ts";
const ACTIONS_DIR = "src/server/actions";

function filesUnder(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((f) => path.posix.join(dir, f.split(path.sep).join("/")))
    .sort();
}

const USE_SERVER = /["']use server["']/;

describe("tables", () => {
  const registered = new Set([...Object.keys(USER_OWNED_TABLES), ...Object.keys(SHARED_TABLES)]);

  it("every table in the database is registered", async () => {
    const tables = Array.from(
      await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
      ),
      (r) => r.table_name,
    );
    const missing = tables.filter((t) => !registered.has(t));
    expect(
      missing,
      `Tables missing from the account isolation registry: ${missing.join(", ")}.\n` +
        `Add each to USER_OWNED_TABLES in ${REGISTRY} (and seed a row for each user in ` +
        `tests/integration/isolation/world.ts), or to SHARED_TABLES with the reason it belongs to no user.`,
    ).toEqual([]);
    const stale = [...registered].filter((t) => !tables.includes(t));
    expect(stale, `Registered tables that no longer exist; remove them from ${REGISTRY}`).toEqual([]);
  });

  it("every table with a user_id column is user-owned, and owner columns exist", async () => {
    const columns = Array.from(
      await db.execute<{ table_name: string; column_name: string }>(
        sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
      ),
    );
    const withUserId = [...new Set(columns.filter((c) => c.column_name === "user_id").map((c) => c.table_name))];
    const notOwned = withUserId.filter((t) => !(t in USER_OWNED_TABLES));
    expect(
      notOwned,
      `Tables with a user_id column must be in USER_OWNED_TABLES in ${REGISTRY}: ${notOwned.join(", ")}`,
    ).toEqual([]);
    for (const [table, { ownerColumn }] of Object.entries(USER_OWNED_TABLES)) {
      expect(
        columns.some((c) => c.table_name === table && c.column_name === ownerColumn),
        `USER_OWNED_TABLES.${table}.ownerColumn = "${ownerColumn}" is not a column of ${table}`,
      ).toBe(true);
    }
  });

  it("every table in the Drizzle schema is registered", () => {
    const tables = (Object.values(schema) as unknown[]).flatMap((v) => (is(v, PgTable) ? [getTableName(v)] : []));
    const missing = tables.filter((t) => !registered.has(t));
    expect(
      missing,
      `Tables in src/server/db/schema.ts missing from ${REGISTRY}: ${missing.join(", ")}. ` +
        `Add each to USER_OWNED_TABLES (and seed it in world.ts) or to SHARED_TABLES with a reason.`,
    ).toEqual([]);
  });

  it("the seeded world gives A at least one row in every user-owned table", async () => {
    const { a } = await seedWorld();
    const empty = Object.entries(await snapshotOf(a.id))
      .filter(([, rows]) => rows.length === 0)
      .map(([table]) => table);
    expect(
      empty,
      `A owns no rows in ${empty.join(", ")}, so the isolation snapshot can't see changes there. ` +
        `Seed them in seedAccount() in tests/integration/isolation/world.ts.`,
    ).toEqual([]);
  });
});

describe("server actions", () => {
  it("every exported server action has cross-user cases or an exemption", async () => {
    const files = filesUnder(ACTIONS_DIR).filter(
      (f) => /\.tsx?$/.test(f) && USE_SERVER.test(readFileSync(path.join(ROOT, f), "utf8")),
    );
    expect(files.length, `no "use server" modules found in ${ACTIONS_DIR}`).toBeGreaterThan(0);

    const exported: string[] = [];
    for (const file of files) {
      const mod = (await import(/* @vite-ignore */ path.join(ROOT, file))) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        expect(exported, `server action name ${name} (in ${file}) is exported twice`).not.toContain(name);
        exported.push(name);
      }
    }

    const missing = exported.filter((name) => !(name in ACTION_COVERAGE));
    expect(
      missing,
      `Server actions without an isolation case: ${missing.join(", ")}.\n` +
        `Add each to ACTION_COVERAGE in ${REGISTRY} with cases that call it as B using A's ids ` +
        `(every id-bearing field) and the expected "<Entity> not found" error, or an exemption ` +
        `explaining why it takes no ids (and a test in actions.test.ts that it only touches the caller's data).`,
    ).toEqual([]);
    const stale = Object.keys(ACTION_COVERAGE).filter((name) => !exported.includes(name));
    expect(stale, `ACTION_COVERAGE lists actions that no longer exist; remove them from ${REGISTRY}`).toEqual([]);
  });

  it(`"use server" appears only in ${ACTIONS_DIR}`, () => {
    const elsewhere = filesUnder("src").filter(
      (f) =>
        /\.[jt]sx?$/.test(f) &&
        !f.startsWith(`${ACTIONS_DIR}/`) &&
        USE_SERVER.test(readFileSync(path.join(ROOT, f), "utf8")),
    );
    expect(
      elsewhere,
      `Server actions outside ${ACTIONS_DIR} escape the isolation coverage check. ` +
        `Move them into a "use server" module there and register them in ACTION_COVERAGE (${REGISTRY}).`,
    ).toEqual([]);
  });
});

describe("route handlers and pages", () => {
  const appFiles = filesUnder("src/app");

  it("every route handler is registered", () => {
    const routes = appFiles.filter((f) => /(^|\/)route\.[jt]sx?$/.test(f));
    const missing = routes.filter((f) => !(f in ROUTE_COVERAGE));
    expect(
      missing,
      `Route handlers missing from ROUTE_COVERAGE in ${REGISTRY}: ${missing.join(", ")}.\n` +
        `Add each with { cases } and add cross-user cases for it to ROUTE_CASES in ` +
        `tests/integration/isolation/routes.test.ts, or { exempt: "<why it can't reach user data>" }.`,
    ).toEqual([]);
    const stale = Object.keys(ROUTE_COVERAGE).filter((f) => !routes.includes(f));
    expect(stale, `ROUTE_COVERAGE lists files that no longer exist; remove them from ${REGISTRY}`).toEqual([]);
  });

  it("every page and layout is registered", () => {
    const pages = appFiles.filter((f) => /(^|\/)(page|layout|template|default)\.[jt]sx?$/.test(f));
    const missing = pages.filter((f) => !(f in PAGE_COVERAGE));
    expect(
      missing,
      `Pages/layouts missing from PAGE_COVERAGE in ${REGISTRY}: ${missing.join(", ")}.\n` +
        `Add each with { cases } and add cases calling it as B to PAGE_CASES in ` +
        `tests/integration/isolation/pages.test.ts (ids from A must 404), or { exempt: "<why it reads no user data>" }.`,
    ).toEqual([]);
    const stale = Object.keys(PAGE_COVERAGE).filter((f) => !pages.includes(f));
    expect(stale, `PAGE_COVERAGE lists files that no longer exist; remove them from ${REGISTRY}`).toEqual([]);
  });
});
