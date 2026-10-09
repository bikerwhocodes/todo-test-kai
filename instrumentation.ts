// Startup gate (A8, R11). Next.js runs `register()` once per server process,
// before the first request is served.
//
// This is the difference between having a guard and being guarded by it. The
// npm script and /api/health both report role safety, but a report nobody
// reads does not stop a deployment pointed at a superuser connection — and
// that misconfiguration is SILENT: every policy in 002_security.sql becomes
// decorative while the app keeps answering normally. So the process refuses to
// come up instead.
export async function register(): Promise<void> {
  // pg is node-only; the edge runtime also evaluates this file.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const url = process.env.DATABASE_URL;
  // No fallback connection string, deliberately: a default that quietly
  // reached a developer's superuser socket is exactly how RLS gets disabled
  // in production without anyone noticing.
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

  const { assertSafeRuntimeRole, assertSafeSchema } = await import("./db/guard.ts");
  const role = await assertSafeRuntimeRole(url);
  const schema = await assertSafeSchema(url);
  console.log(
    `[startup] role "${role.role}" is non-owner, non-superuser, no BYPASSRLS; ` +
      `RLS coverage and the runtime/auth privilege split are intact ` +
      `(${schema.unprotected.length + schema.unclassified.length + schema.leakedPrivileges.length} findings).`,
  );
}
