-- 002_security.sql — Row-level security as an independent second layer.
--
-- Application-level scoping (WHERE id = $1 AND user_id = $2) is the first
-- layer and lives in the application. This file is the backstop that holds
-- even when the application gets it wrong.
--
-- Two traps this file deliberately avoids:
--
--   1. ENABLE ROW LEVEL SECURITY alone does NOT constrain the table OWNER.
--      Verified: with ENABLE only, the owner saw every user's rows and RLS was
--      silently inert. FORCE is what closes it, and the runtime role being a
--      non-owner is what makes the whole arrangement meaningful.
--
--   2. current_setting('app.user_id', true) returns an EMPTY STRING, not NULL,
--      when no identity is set. Casting '' to uuid RAISES
--      (invalid input syntax for type uuid: ""), which turns a missing identity
--      into a 500 instead of a clean denial. nullif(..., '') makes the policy
--      fail CLOSED: zero rows, no error.

CREATE FUNCTION current_app_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $fn$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $fn$;

-- users: a caller may see and update only their own row. The pre-identity
-- lookups that signup and login need (by email, by session token) cannot be
-- expressed as an app.user_id policy, so the auth tables below are granted to
-- a separate role in NEXT-2 rather than to the application runtime role.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING      (id = current_app_user())
  WITH CHECK (id = current_app_user());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'recurrence_rules', 'tasks',
    'task_dependencies', 'day_plans', 'day_plan_items'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (user_id = current_app_user()) '
      'WITH CHECK (user_id = current_app_user())', t || '_owner', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Runtime role privileges.
--
-- The runtime role gets DML on the application tables and nothing else: no
-- ownership, no DDL, no privileges on sessions/accounts/verifications. It
-- therefore cannot disable RLS on a table it does not own, which is the point.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  projects, recurrence_rules, tasks, task_dependencies, day_plans, day_plan_items
  TO nextup_runtime;

-- Own-row reads (the user's IANA timezone, from which "today" is derived) and
-- own-row profile updates. No INSERT: account creation belongs to NEXT-2's
-- auth role, not to the application runtime role.
GRANT SELECT, UPDATE ON users TO nextup_runtime;

GRANT EXECUTE ON FUNCTION current_app_user() TO nextup_runtime;
