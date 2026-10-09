import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/env-init.mjs");
const secretKeys = [
  "POSTGRES_PASSWORD",
  "NEXTUP_OWNER_PASSWORD",
  "NEXTUP_RUNTIME_PASSWORD",
  "NEXTUP_AUTH_PASSWORD",
  "BETTER_AUTH_SECRET",
];
const urlKeys = [
  "POSTGRES_SUPERUSER_URL",
  "MIGRATION_DATABASE_URL",
  "DATABASE_URL",
  "AUTH_DATABASE_URL",
];

function readEnv(path: string) {
  const text = readFileSync(path, "utf8");
  return {
    text,
    values: new Map(text.split("\n").filter((line) => line.includes("=")).map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    })),
  };
}

test("env:init applies explicit isolation overrides without rotating secrets", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nextup-env-init-"));
  try {
    const first = spawnSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, NEXTUP_DB_PORT: "56551", COMPOSE_PROJECT_NAME: "next2-before" },
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    const before = readEnv(join(cwd, ".env.local"));

    const second = spawnSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, NEXTUP_DB_PORT: "56552", COMPOSE_PROJECT_NAME: "next2-after" },
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    const after = readEnv(join(cwd, ".env.local"));

    assert.equal(after.values.get("NEXTUP_DB_PORT"), "56552");
    assert.equal(after.values.get("COMPOSE_PROJECT_NAME"), "next2-after");
    for (const key of urlKeys) assert.equal(new URL(after.values.get(key)!).port, "56552", key);
    for (const key of secretKeys) assert.equal(after.values.get(key), before.values.get(key), key);
    assert.equal(after.text.match(/^NEXTUP_DB_PORT=/gm)?.length, 1);
    assert.equal(after.text.match(/^COMPOSE_PROJECT_NAME=/gm)?.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
