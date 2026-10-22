import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Stop-gap for the lint rule that lands with the M0 scaffold: src/core must
// stay pure — no imports from server/ or app/, no clock or environment reads.
const coreDir = join(import.meta.dirname, "../../../src/core");

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
  );

const forbidden: Array<[string, RegExp]> = [
  ["import from server/ or app/", /from\s+["'][^"']*\/(server|app)(\/|["'])/],
  ["import of a node: builtin", /from\s+["']node:/],
  ["Date.now()", /\bDate\.now\s*\(/],
  ["new Date() without arguments", /\bnew\s+Date\s*\(\s*\)/],
  ["process.env", /\bprocess\.env\b/],
];

describe("src/core purity", () => {
  it.each(files(coreDir).map((f) => [relative(coreDir, f), f]))("%s", (_name, file) => {
    const src = readFileSync(file, "utf8");
    const hits = forbidden.filter(([, re]) => re.test(src)).map(([label]) => label);
    expect(hits).toEqual([]);
  });
});
