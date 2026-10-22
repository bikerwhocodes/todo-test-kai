import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "../../src/server/db/client";
import { createRepo } from "../../src/server/repo";

const repoDir = join(import.meta.dirname, "../../src/server/repo");

function firstParamName(fn: Function): string | undefined {
  const params = /^[^(]*\(([^)]*)\)/.exec(fn.toString())?.[1] ?? "";
  return params.split(",")[0]?.trim().split(/[\s=:]/)[0] || undefined;
}

/** Returns the argument text of every `.where(...)` call in `source`. */
function whereClauses(source: string): string[] {
  const out: string[] = [];
  for (let i = source.indexOf(".where("); i !== -1; i = source.indexOf(".where(", i + 1)) {
    let depth = 0;
    let j = i + ".where".length;
    for (; j < source.length; j++) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")" && --depth === 0) break;
    }
    out.push(source.slice(i + ".where(".length, j));
  }
  return out;
}

describe("repo layer", () => {
  // Constructing the repo doesn't touch the database.
  const repo = createRepo({} as Db);
  const methods = Object.entries(repo).flatMap(([entity, fns]) =>
    Object.entries(fns as Record<string, Function>).map(([name, fn]) => [`${entity}.${name}`, fn] as const),
  );

  it("exposes methods", () => {
    expect(methods.length).toBeGreaterThan(0);
  });

  it.each(methods)("%s takes userId as its first argument", (_name, fn) => {
    expect(firstParamName(fn)).toBe("userId");
  });

  const sources = readdirSync(repoDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, readFileSync(join(repoDir, f), "utf8")] as const);

  it.each(sources)("every query filter in %s is scoped by userId", (_file, source) => {
    for (const clause of whereClauses(source)) {
      expect(clause, `.where(${clause})`).toMatch(/\buserId\b/);
    }
  });
});
