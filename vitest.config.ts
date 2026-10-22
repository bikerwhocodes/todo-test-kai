import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
// `server-only` throws when imported outside a React Server Components build.
const serverOnlyStub = fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url));

// Same file `next dev` reads; already-set variables (e.g. in CI) win.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@": src } },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias: { "@": src, "server-only": serverOnlyStub } },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/integration/setup.ts"],
          // Tests share one database; run files one after another.
          fileParallelism: false,
        },
      },
    ],
  },
});
