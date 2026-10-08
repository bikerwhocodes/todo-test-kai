// Creates the two application roles as the superuser, then migrates as the
// migration owner. Idempotent: safe to re-run.
//
// The separation is the whole point. The migration owner owns every table; the
// runtime role owns nothing, so it cannot turn off the row-level security that
// constrains it.
import pg from "pg";
import { migrate } from "./migrate.ts";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
};

async function ensureRoles(): Promise<void> {
  const client = new pg.Client({ connectionString: required("POSTGRES_SUPERUSER_URL") });
  await client.connect();
  try {
    // Passwords travel as bound parameters into session GUCs and are quoted by
    // format(%L) inside the DO block, so they are never spliced into SQL text.
    await client.query("SELECT set_config('nextup.owner_pw', $1, false)", [required("NEXTUP_OWNER_PASSWORD")]);
    await client.query("SELECT set_config('nextup.runtime_pw', $1, false)", [required("NEXTUP_RUNTIME_PASSWORD")]);

    await client.query(`
      DO $$
      DECLARE
        r record;
      BEGIN
        FOR r IN SELECT * FROM (VALUES
          ('nextup_owner',   'nextup.owner_pw'),
          ('nextup_runtime', 'nextup.runtime_pw')
        ) AS v(role, guc) LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role) THEN
            EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', r.role, current_setting(r.guc));
          ELSE
            EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r.role, current_setting(r.guc));
          END IF;
          -- Asserted every run, not just at creation: a role that drifted into
          -- superuser or BYPASSRLS would make RLS decorative.
          EXECUTE format(
            'ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
            r.role);
        END LOOP;
      END $$;`);

    await client.query("GRANT CREATE, USAGE ON SCHEMA public TO nextup_owner");
    await client.query("GRANT USAGE ON SCHEMA public TO nextup_runtime");
    console.log("Roles nextup_owner and nextup_runtime are present and non-privileged.");
  } finally {
    await client.end();
  }
}

await ensureRoles();
const applied = await migrate(required("MIGRATION_DATABASE_URL"));
const n = applied.filter((r) => !r.skipped).length;
console.log(n === 0 ? "Schema already up to date." : `Applied ${n} migration(s).`);
