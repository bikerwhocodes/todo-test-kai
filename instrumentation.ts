// Startup gate (A8, R11). Next.js calls register() once per server process,
// before the first request is served.
//
// Without this the guard exists but does not guard: `npm run guard` and
// /api/health both *report* role safety, and a report nobody reads does not
// stop a deployment pointed at a superuser connection. That misconfiguration
// is silent — every policy in 002_security.sql becomes decorative while the
// app keeps answering normally — so startup throws instead.
//
// Precisely what that gets you, verified rather than assumed: with the
// superuser connection, `next start` binds the port but every request returns
// 500 and no page renders; with nextup_runtime it logs the line below and
// serves 200. So this "refuses to serve", which is what the Technical Spec's
// §4.6 asks for — it does NOT exit the process, and a health check that only
// pings the port would still see something listening.
//
// Missed on this branch and found by comparison with the parallel
// run/crystal-flamingo-a2 implementation of the same plan item.
export async function register(): Promise<void> {
  // pg is node-only, and the edge runtime also evaluates this file.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const url = process.env.DATABASE_URL;
  // No fallback connection string, deliberately: a default that quietly
  // reached a developer's superuser socket is how RLS gets disabled in
  // production without anyone noticing.
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

  const { assertRlsCoverage, assertSafeRuntimeRole } = await import("./db/guard.ts");
  const role = await assertSafeRuntimeRole(url);
  const coverage = await assertRlsCoverage(url);
  console.log(
    `[startup] role "${role.role}" is non-owner, non-superuser, no BYPASSRLS; ` +
      `row-level security covers every user-scoped table ` +
      `(${coverage.missing.length + coverage.unclassified.length} findings).`,
  );
}
