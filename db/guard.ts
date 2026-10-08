// Startup assertion: refuse to run the application on an unsafe database role.
//
// Row-level security is only a real boundary if the connecting role is not the
// table owner, not a superuser, and does not hold BYPASSRLS. Any one of those
// makes every policy in 002_security.sql decorative, and it fails silently —
// the application keeps working while returning other users' rows. This turns
// that silent failure into a loud startup crash.
import pg from "pg";

export type RoleSafety = {
  role: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  ownsTables: boolean;
  safe: boolean;
};

export type RlsCoverage = {
  /** Tables that must carry ENABLE + FORCE row-level security. */
  missing: string[];
  /** Tables in neither the protected list nor the allowlist below. */
  unclassified: string[];
  safe: boolean;
};

/**
 * Every table that holds user-scoped rows and must therefore carry
 * ENABLE + FORCE row-level security.
 */
const RLS_REQUIRED = [
  "users", "projects", "recurrence_rules", "tasks",
  "task_dependencies", "day_plans", "day_plan_items",
] as const;

/**
 * Tables deliberately WITHOUT an app.user_id policy, each with its reason.
 * This is an allowlist rather than a skip, because the realistic failure is a
 * NEW table shipping with no policy at all: only naming the exceptions turns
 * that into a startup crash instead of one silently unprotected table.
 *
 *   sessions, accounts, verifications — read before a request has any
 *     identity (user by email, session by token), which an app.user_id policy
 *     cannot express. Contained by grant instead: only nextup_auth can reach
 *     them, and it holds nothing on the tables above.
 *   rate_limits      — Better Auth's counters. No user_id, no user data.
 *   schema_migrations — the migration ledger. No user data.
 */
const RLS_EXEMPT = [
  "sessions", "accounts", "verifications", "rate_limits", "schema_migrations",
] as const;

/**
 * Asserts that row-level security actually covers every user-scoped table.
 *
 * The role check below catches a misconfigured connection; this catches the
 * likelier mistake, which is a table added later without a policy. A role
 * check alone would pass happily on a database with one wide-open table.
 */
export async function checkRlsCoverage(connectionString: string): Promise<RlsCoverage> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`);

    const required = new Set<string>(RLS_REQUIRED);
    const exempt = new Set<string>(RLS_EXEMPT);

    const missing = rows
      .filter((r) => required.has(r.relname))
      .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity)
      .map((r) => r.relname);

    // A required table that is absent entirely is also a failure, not a pass.
    const present = new Set(rows.map((r) => r.relname));
    for (const t of RLS_REQUIRED) if (!present.has(t)) missing.push(`${t} (table absent)`);

    const unclassified = rows
      .map((r) => r.relname)
      .filter((name) => !required.has(name) && !exempt.has(name));

    return { missing, unclassified, safe: missing.length === 0 && unclassified.length === 0 };
  } finally {
    await client.end();
  }
}

export async function checkRoleSafety(connectionString: string): Promise<RoleSafety> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{
      rolsuper: boolean; rolbypassrls: boolean; owns_tables: boolean; role: string;
    }>(`
      SELECT current_user AS role,
             r.rolsuper,
             r.rolbypassrls,
             coalesce(
               pg_get_userbyid(
                 (SELECT c.relowner FROM pg_class c
                   WHERE c.relname = 'tasks'
                     AND c.relnamespace = 'public'::regnamespace)
               ) = current_user, false) AS owns_tables
        FROM pg_roles r
       WHERE r.rolname = current_user`);

    const row = rows[0];
    if (!row) throw new Error("could not resolve current_user in pg_roles");
    const result: RoleSafety = {
      role: row.role,
      isSuperuser: row.rolsuper,
      bypassesRls: row.rolbypassrls,
      ownsTables: row.owns_tables,
      safe: !row.rolsuper && !row.rolbypassrls && !row.owns_tables,
    };
    return result;
  } finally {
    await client.end();
  }
}

export async function assertRlsCoverage(connectionString: string): Promise<RlsCoverage> {
  const c = await checkRlsCoverage(connectionString);
  if (!c.safe) {
    const parts = [
      c.missing.length && `missing ENABLE/FORCE row-level security: ${c.missing.join(", ")}`,
      c.unclassified.length &&
        `in neither the protected list nor the documented exemptions: ` +
          `${c.unclassified.join(", ")} — add each to RLS_REQUIRED (with a policy) ` +
          `or to RLS_EXEMPT (with a reason) in db/guard.ts`,
    ].filter(Boolean);
    throw new Error(`Refusing to start: ${parts.join("; ")}.`);
  }
  return c;
}

export async function assertSafeRuntimeRole(connectionString: string): Promise<RoleSafety> {
  const s = await checkRoleSafety(connectionString);
  if (!s.safe) {
    const reasons = [
      s.isSuperuser && "is a superuser",
      s.bypassesRls && "holds BYPASSRLS",
      s.ownsTables && "owns the application tables",
    ].filter(Boolean);
    throw new Error(
      `Refusing to start: database role "${s.role}" ${reasons.join(" and ")}. ` +
        `Row-level security would be bypassed. Connect as nextup_runtime ` +
        `(see .env.example / db/setup.ts).`,
    );
  }
  return s;
}

if (import.meta.filename === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const s = await assertSafeRuntimeRole(url);
  console.log(`Runtime role "${s.role}" is safe: non-owner, non-superuser, no BYPASSRLS.`);
  await assertRlsCoverage(url);
  console.log(
    `Row-level security covers all ${RLS_REQUIRED.length} user-scoped tables; ` +
      `${RLS_EXEMPT.length} documented exemptions, no unclassified table.`,
  );
}
