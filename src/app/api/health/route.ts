import { getPool } from "../../../../db/client.ts";
import { checkRoleSafety } from "../../../../db/guard.ts";

export const dynamic = "force-dynamic";

/**
 * Liveness plus a role-safety readout. Reports the migration ledger and
 * confirms the connected role cannot bypass row-level security.
 */
export async function GET(): Promise<Response> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return Response.json({ ok: false, error: "DATABASE_URL is not set" }, { status: 500 });
  }
  try {
    const { rows } = await getPool().query<{ version: string; migrations: number }>(
      `SELECT current_setting('server_version') AS version,
              (SELECT count(*)::int FROM schema_migrations) AS migrations`,
    );
    const safety = await checkRoleSafety(url);
    const body = {
      ok: safety.safe,
      postgres: rows[0]?.version ?? null,
      migrationsApplied: rows[0]?.migrations ?? 0,
      role: safety.role,
      roleSafe: safety.safe,
    };
    return Response.json(body, { status: safety.safe ? 200 : 503 });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
