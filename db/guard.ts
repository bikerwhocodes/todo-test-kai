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
}
