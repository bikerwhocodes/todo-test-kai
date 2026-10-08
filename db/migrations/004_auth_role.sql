-- 004_auth_role.sql — a third database role for the auth library.
--
-- This resolves the boundary NEXT-1 deliberately left open.
--
-- The problem: `sessions`, `accounts` and `verifications` are read BEFORE a
-- request has any identity — a user is looked up by email during sign-in, a
-- session by its cookie token. An `app.user_id` RLS policy cannot express
-- that, so NEXT-1 gave the runtime role no privilege on those tables at all:
-- safe, but login could never work.
--
-- The rejected fix is widening nextup_runtime's grants, which would hand every
-- application query the ability to read every session token in the database.
--
-- The fix taken instead: a separate `nextup_auth` role that holds DML on the
-- four identity tables and NOTHING on the six application tables, and a
-- `nextup_runtime` role that keeps its own-row-only access to `users` and
-- nothing on the session tables. Neither role can do the other's job, so a
-- compromise of application query code cannot reach a session token, and a
-- compromise of the auth library cannot read anyone's tasks.
--
-- The containment for the identity tables is therefore the ROLE boundary, not
-- an RLS predicate. That is the honest trade: a pre-identity read cannot be
-- expressed as a post-identity policy, so the privilege is scoped to the one
-- role that needs it and withheld from the one that does not.

-- ---------------------------------------------------------------------------
-- Better Auth's rate-limit store.
--
-- `rateLimit: { storage: "database" }` is required rather than the default
-- in-memory store: the default is per-process, so it would reset on deploy
-- and count separately per instance. Field names come from Better Auth's own
-- rateLimit model (key, count, lastRequest); `last_request` is epoch
-- milliseconds, hence bigint rather than timestamptz.
--
-- No user data and no user_id, so no RLS policy: it is scoped by grant only.
-- ---------------------------------------------------------------------------

CREATE TABLE rate_limits (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text    NOT NULL UNIQUE,
  count        integer NOT NULL DEFAULT 0,
  last_request bigint  NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- `users` keeps FORCE row-level security from 002. The existing users_self
-- policy restricts every caller to their own row, which is exactly wrong for
-- sign-up (no row yet) and sign-in (lookup by email, no identity yet).
--
-- Rather than dropping that policy or exempting the table, this adds a SECOND
-- policy scoped TO the auth role. Permissive policies are OR'd, so:
--
--   nextup_auth    -> users_self OR users_auth  -> every row (what it needs)
--   nextup_runtime -> users_self only           -> its own row, unchanged
--
-- The role-scoped policy is what keeps the widened access from leaking to the
-- application runtime role, and it is enforced by Postgres rather than by
-- remembering to filter in application code.
-- ---------------------------------------------------------------------------

CREATE POLICY users_auth ON users
  TO nextup_auth
  USING      (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants. Least privilege, and the omissions are deliberate:
--
--   * No DELETE on `users`. Deleting a user cascades to every project, task,
--     dependency, recurrence rule and plan they own. Account deletion is not
--     an MVP feature, so the auth role cannot perform that destruction.
--   * Nothing at all on projects, recurrence_rules, tasks, task_dependencies,
--     day_plans, day_plan_items. The auth role cannot read or write user data.
--   * No ownership and no DDL, so it cannot turn RLS off on `users`.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE                 ON users         TO nextup_auth;
GRANT SELECT, INSERT, UPDATE, DELETE         ON sessions      TO nextup_auth;
GRANT SELECT, INSERT, UPDATE, DELETE         ON accounts      TO nextup_auth;
GRANT SELECT, INSERT, UPDATE, DELETE         ON verifications TO nextup_auth;
GRANT SELECT, INSERT, UPDATE, DELETE         ON rate_limits   TO nextup_auth;

GRANT EXECUTE ON FUNCTION current_app_user() TO nextup_auth;
