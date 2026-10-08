// Project repository.
//
// Two rules hold for every function here, and they are what account isolation
// rests on:
//
//   1. `userId` is the FIRST parameter of every function. There is no overload
//      that takes an id alone, so a caller cannot express an unscoped query.
//   2. Every statement runs inside withUser(), which binds app.user_id for
//      that transaction only, and ALSO carries an explicit `AND user_id = $n`.
//      The explicit predicate is the application layer; RLS is the independent
//      backstop underneath it. Either alone would be enough; the point is that
//      a mistake in one is caught by the other.
import type pg from "pg";
import { withUser } from "./client.ts";

export type Project = {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
};

const COLUMNS = `id, name, archived_at AS "archivedAt", created_at AS "createdAt"`;

export async function listProjects(userId: string): Promise<Project[]> {
  return withUser(userId, async (c: pg.PoolClient) => {
    const { rows } = await c.query<Project>(
      `SELECT ${COLUMNS} FROM projects WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows;
  });
}

/** Returns null both when the project does not exist and when it is another user's. */
export async function getProject(userId: string, id: string): Promise<Project | null> {
  return withUser(userId, async (c: pg.PoolClient) => {
    const { rows } = await c.query<Project>(
      `SELECT ${COLUMNS} FROM projects WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ?? null;
  });
}

export async function createProject(userId: string, name: string): Promise<Project> {
  return withUser(userId, async (c: pg.PoolClient) => {
    const { rows } = await c.query<Project>(
      `INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [userId, name],
    );
    return rows[0]!;
  });
}

export async function renameProject(
  userId: string,
  id: string,
  name: string,
): Promise<Project | null> {
  return withUser(userId, async (c: pg.PoolClient) => {
    const { rows } = await c.query<Project>(
      `UPDATE projects SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING ${COLUMNS}`,
      [name, id, userId],
    );
    return rows[0] ?? null;
  });
}

/** False when the project does not exist OR belongs to someone else. */
export async function deleteProject(userId: string, id: string): Promise<boolean> {
  return withUser(userId, async (c: pg.PoolClient) => {
    const { rowCount } = await c.query(
      "DELETE FROM projects WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  });
}
