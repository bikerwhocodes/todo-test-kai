// Startup assertions: refuse to run the application on an unsafe database role,
// or against a schema whose protections have quietly regressed.
//
// Row-level security is only a real boundary if the connecting role is not the
// table owner, not a superuser, and does not hold BYPASSRLS. Any one of those
// makes every policy in 002_security.sql decorative, and it fails SILENTLY —
// the application keeps working while returning other users' rows. This turns
// that silent failure into a loud startup crash.
//
// Three further things are checked, because the role check alone misses the
// likelier mistakes:
//
//   * RLS COVERAGE. A new domain table shipped without ENABLE + FORCE is
//     unprotected, and nothing else would notice. Every table is matched
//     against one of two explicit lists, so a table that appears in NEITHER
//     also fails — an allowlist, not a pattern match.
//
//   * THE PRIVILEGE SPLIT, BOTH WAYS. The runtime role must hold nothing on
//     the identity tables, and the auth role must hold nothing on the domain
//     tables (004_auth_role.sql). Each role is meant to be strictly less than
//     the whole, and a later migration widening either one would otherwise be
//     invisible until a breach. These assertions are the reason "give the auth
//     library its own role" is an enforced boundary rather than a comment.
import pg from "pg";

/** The six user-scoped domain tables, plus `users`: all must be FORCE RLS. */
const RLS_REQUIRED = [
  "users", "projects", "recurrence_rules", "tasks",
  "task_dependencies", "day_plans", "day_plan_items",
] as const;

/**
 * Tables deliberately WITHOUT an app.user_id policy, each with a reason.
 * They are read before a request has any identity, so such a policy would
 * deny the one path that must work before identity exists. Their containment
 * is the privilege split instead, asserted below.
 */
const RLS_EXEMPT = ["sessions", "accounts", "verifications", "rate_limits", "schema_migrations"] as const;

/** Tables the RUNTIME role must hold no privilege of any kind on. */
const RUNTIME_FORBIDDEN = ["sessions", "accounts", "verifications", "rate_limits"] as const;

/** Tables the AUTH role must hold no privilege of any kind on. */
const AUTH_FORBIDDEN = [
  "projects", "recurrence_rules", "tasks",
  "task_dependencies", "day_plans", "day_plan_items",
] as const;

const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

export type RoleSafety = {
  role: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  ownsTables: boolean;
  safe: boolean;
};

export type SchemaSafety = {
  /** Tables that should be FORCE RLS but are not. */
  unprotected: string[];
  /** Tables in neither the required nor the exempt list. */
  unclassified: string[];
  /** e.g. "nextup_runtime has SELECT on sessions" */
  leakedPrivileges: string[];
  safe: boolean;
};

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

/**
 * Checks RLS coverage and the runtime/auth privilege split.
 *
 * Runs on any connection that can read the catalogues — the privilege
 * questions are asked ABOUT the two named roles via has_table_privilege, not
 * about the connected role, so this reports the same answer whoever calls it.
 */
export async function checkSchemaSafety(connectionString: string): Promise<SchemaSafety> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: tables } = await client.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`);

    const required = new Set<string>(RLS_REQUIRED);
    const exempt = new Set<string>(RLS_EXEMPT);

    const unprotected = tables
      .filter((t) => required.has(t.relname) && !(t.relrowsecurity && t.relforcerowsecurity))
      .map((t) => t.relname);

    // A table in neither list is the realistic regression: a new domain table
    // landing with no policy. Only an allowlist catches that.
    const unclassified = tables
      .filter((t) => !required.has(t.relname) && !exempt.has(t.relname))
      .map((t) => t.relname);

    const present = new Set(tables.map((t) => t.relname));
    const checks: { role: string; table: string }[] = [
      ...RUNTIME_FORBIDDEN.map((table) => ({ role: "nextup_runtime", table })),
      ...AUTH_FORBIDDEN.map((table) => ({ role: "nextup_auth", table })),
    ].filter((c) => present.has(c.table));

    const leakedPrivileges: string[] = [];
    if (checks.length > 0) {
      // One round trip: ask the catalogue about every (role, table, privilege)
      // triple at once rather than issuing 40 queries at boot.
      const { rows: leaks } = await client.query<{ role: string; table: string; priv: string }>(
        `SELECT q.role, q.table_name AS table, p.priv
           FROM unnest($1::text[], $2::text[]) AS q(role, table_name)
           CROSS JOIN unnest($3::text[]) AS p(priv)
          WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = q.role)
            AND has_table_privilege(q.role, q.table_name::regclass, p.priv)`,
        [checks.map((c) => c.role), checks.map((c) => c.table), [...DML]],
      );
      for (const l of leaks) leakedPrivileges.push(`${l.role} has ${l.priv} on ${l.table}`);
    }

    return {
      unprotected,
      unclassified,
      leakedPrivileges,
      safe: unprotected.length === 0 && unclassified.length === 0 && leakedPrivileges.length === 0,
    };
  } finally {
    await client.end();
  }
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

export async function assertSafeSchema(connectionString: string): Promise<SchemaSafety> {
  const s = await checkSchemaSafety(connectionString);
  if (!s.safe) {
    const reasons = [
      s.unprotected.length > 0 &&
        `these tables are not FORCE ROW LEVEL SECURITY: ${s.unprotected.join(", ")}`,
      s.unclassified.length > 0 &&
        `these tables are in neither the RLS-required nor the RLS-exempt list, ` +
        `so their protection is unknown: ${s.unclassified.join(", ")} ` +
        `(classify them in db/guard.ts)`,
      s.leakedPrivileges.length > 0 &&
        `the runtime/auth privilege split has been widened: ${s.leakedPrivileges.join("; ")}`,
    ].filter(Boolean);
    throw new Error(`Refusing to start: ${reasons.join(". ")}.`);
  }
  return s;
}

if (import.meta.filename === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const s = await assertSafeRuntimeRole(url);
  console.log(`Runtime role "${s.role}" is safe: non-owner, non-superuser, no BYPASSRLS.`);
  await assertSafeSchema(url);
  console.log(
    `Schema is safe: ${RLS_REQUIRED.length} tables FORCE RLS, ` +
      `no unclassified table, runtime/auth privilege split intact.`,
  );
}
