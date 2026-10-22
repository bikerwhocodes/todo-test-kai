import { runMigrations } from "@/server/db/migrate";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must be set for integration tests");

process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";

await runMigrations(url);
