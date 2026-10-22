import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "./client";

export const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  try {
    await runMigrations(db);
    console.log("Migrations applied");
  } finally {
    await pool.end();
  }
}
