// Runtime database access. Every query runs inside withUser(), which is the
// only place request identity is established.
import pg from "pg";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Runs `fn` in a transaction with the row-level-security identity bound to
 * `userId` for that transaction only.
 *
 * The third argument to set_config is is_local = true, which is SET LOCAL.
 * That is what keeps identity from outliving the transaction and leaking to
 * the next request that borrows the same pooled connection — a session-level
 * SET would persist on the connection after release.
 */
export async function withUser<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  poolOverride?: pg.Pool,
): Promise<T> {
  const client = await (poolOverride ?? getPool()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
