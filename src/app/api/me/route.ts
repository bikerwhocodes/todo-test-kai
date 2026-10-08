import { getSession } from "../../../../lib/session.ts";
import { handle, invalid, unauthenticated } from "../../../../lib/http.ts";
import { withUser } from "../../../../db/client.ts";

export const dynamic = "force-dynamic";

export const GET = (req: Request): Promise<Response> =>
  handle(async () => {
    const s = await getSession(req);
    if (!s) throw unauthenticated();
    // Read through the RUNTIME role, which under users_self can see exactly
    // one row — its own. A bug that dropped the WHERE clause would still
    // return a single row here rather than the user table.
    const row = await withUser(s.userId, async (c) => {
      const { rows } = await c.query<{ id: string; email: string; timezone: string }>(
        "SELECT id, email, timezone FROM users WHERE id = $1", [s.userId]);
      return rows[0] ?? null;
    });
    if (!row) throw unauthenticated();
    return Response.json({ user: row });
  });

export const PATCH = (req: Request): Promise<Response> =>
  handle(async () => {
    const s = await getSession(req);
    if (!s) throw unauthenticated();
    const body = (await req.json().catch(() => null)) as { timezone?: unknown } | null;
    const tz = body?.timezone;
    if (typeof tz !== "string" || tz.length === 0) {
      throw invalid("timezone must be an IANA zone identifier.", { path: ["timezone"] });
    }
    try {
      const row = await withUser(s.userId, async (c) => {
        const { rows } = await c.query<{ id: string; timezone: string }>(
          "UPDATE users SET timezone = $2, updated_at = now() WHERE id = $1 RETURNING id, timezone",
          [s.userId, tz]);
        return rows[0] ?? null;
      });
      if (!row) throw unauthenticated();
      return Response.json({ user: row });
    } catch (err) {
      // The database validates the zone against its own tz database, so an
      // unknown identifier is a 422 rather than a 500.
      const e = err as { code?: string };
      if (e.code === "22023" || e.code === "23514") {
        throw invalid("Unknown IANA timezone.", { path: ["timezone"] });
      }
      throw err;
    }
  });
