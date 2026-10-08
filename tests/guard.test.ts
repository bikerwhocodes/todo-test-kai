// R11 — the startup guard fails when given an unsafe database role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeRuntimeRole, checkRoleSafety } from "../db/guard.ts";

const url = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};

test("R11: the guard accepts the real runtime role", async () => {
  const s = await assertSafeRuntimeRole(url("DATABASE_URL"));
  assert.equal(s.role, "nextup_runtime");
  assert.deepEqual(
    { superuser: s.isSuperuser, bypass: s.bypassesRls, owns: s.ownsTables },
    { superuser: false, bypass: false, owns: false });
});

test("R11: the guard REJECTS the migration owner", async () => {
  const s = await checkRoleSafety(url("MIGRATION_DATABASE_URL"));
  assert.equal(s.ownsTables, true, "nextup_owner does own the tables");
  assert.equal(s.safe, false);
  await assert.rejects(
    () => assertSafeRuntimeRole(url("MIGRATION_DATABASE_URL")),
    /owns the application tables/,
    "starting the app as the table owner must crash loudly");
});

test("R11: the guard REJECTS a superuser", async () => {
  const s = await checkRoleSafety(url("POSTGRES_SUPERUSER_URL"));
  assert.equal(s.isSuperuser, true);
  assert.equal(s.safe, false);
  await assert.rejects(
    () => assertSafeRuntimeRole(url("POSTGRES_SUPERUSER_URL")),
    /is a superuser/,
    "starting the app as a superuser must crash loudly");
});
