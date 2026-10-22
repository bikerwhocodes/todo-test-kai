import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/server/db/migrate";
import { useTestDb } from "./helpers";

const { db, pool } = useTestDb();

describe("migrations", () => {
  it("apply to an empty database and are idempotent on re-run", async () => {
    // global-setup already migrated a fresh database; a second run must be a no-op.
    await expect(runMigrations(db)).resolves.toBeUndefined();

    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(["projects", "subtasks", "tasks", "user"]);
  });

  it("creates the composite user-scoped foreign keys", async () => {
    const { rows } = await pool.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('tasks_user_project_fk', 'subtasks_user_task_fk') order by conname`,
    );
    expect(rows).toEqual([
      {
        conname: "subtasks_user_task_fk",
        def: "FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE",
      },
      {
        conname: "tasks_user_project_fk",
        def: "FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id)",
      },
    ]);
  });
});
