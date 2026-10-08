import { getPool } from "../../../../db/client.ts";
import { checkRoleSafety, checkSchemaSafety } from "../../../../db/guard.ts";

export const dynamic = "force-dynamic";

/**
 * Liveness plus a safety readout. Reports the migration ledger, confirms the
 * connected role cannot bypass row-level security, and confirms RLS coverage
 * and the runtime/auth privilege split are still intact. Answers 503 — not
 * 200-with-a-warning — when any of that is false.
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
    const [safety, schema] = await Promise.all([checkRoleSafety(url), checkSchemaSafety(url)]);
    const ok = safety.safe && schema.safe;
    const body = {
      ok,
      postgres: rows[0]?.version ?? null,
      migrationsApplied: rows[0]?.migrations ?? 0,
      role: safety.role,
      roleSafe: safety.safe,
      // RLS coverage plus the runtime/auth privilege split. Reported as a
      // boolean with the findings named, so a widened grant is visible to
      // monitoring and not only to a failed boot.
      schemaSafe: schema.safe,
      ...(schema.safe ? {} : {
        findings: {
          unprotected: schema.unprotected,
          unclassified: schema.unclassified,
          leakedPrivileges: schema.leakedPrivileges,
        },
      }),
    };
    return Response.json(body, { status: ok ? 200 : 503 });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
