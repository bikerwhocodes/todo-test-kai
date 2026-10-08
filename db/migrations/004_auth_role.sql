-- 004_auth_role.sql — a THIRD role for the auth library, and the rate-limit
-- store that Better Auth's database-backed limiter needs.
--
-- Why a third role rather than widening nextup_runtime.
--
-- Better Auth must read `users` by email and `sessions` by token BEFORE a
-- request has any identity. An `app.user_id` RLS policy cannot express that:
-- with no identity set the policy denies every row (correctly — see 002), so
-- login could never complete. 002 therefore left the runtime role with no
-- privilege at all on sessions/accounts/verifications.
--
-- The tempting fix is to grant the runtime role what the auth library needs.
-- That is rejected: it would give the code that serves ordinary task requests
-- permanent read access to every user's row and every session token, which is
-- precisely the blast radius RLS exists to contain.
--
-- Instead the privilege is SPLIT, and the split is mutually exclusive:
--
--   nextup_runtime  DML on the six domain tables + own-row users. NO access
--                   to sessions/accounts/verifications/rate_limits.
--   nextup_auth     DML on the four identity tables + rate_limits. NO access
--                   to ANY domain table — it cannot read one task or project.
--
-- Neither role is a superset of the other, so compromising either reaches
-- strictly less than the whole. db/guard.ts asserts BOTH directions at
-- startup, so a later migration that quietly widens one of them fails the
-- boot instead of passing review.

-- ---------------------------------------------------------------------------
-- Rate limiting store (A9). Better Auth's limiter defaults to in-memory,
-- which is per-instance and therefore not a limit at all behind more than one
-- server. `storage: "database"` needs this table; its shape is Better Auth's
-- rateLimit model (key unique, count, lastRequest as epoch millis).
--
-- Not user-scoped: rows are keyed by IP and path, and are written before any
-- identity exists. No RLS, by the same argument as the identity tables; the
-- containment is that only nextup_auth is granted anything on it.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text    NOT NULL UNIQUE,
  count        integer NOT NULL,
  last_request bigint  NOT NULL
);

-- ---------------------------------------------------------------------------
-- The pre-identity read path on `users`.
--
-- `users` is FORCE RLS with policy users_self (id = current_app_user()), which
-- is what confines the runtime role to its own row. Permissive policies are
-- OR'd, and a policy with a TO clause is only considered for those roles, so
-- adding an auth-role-only policy widens NOTHING for nextup_runtime:
--
--   nextup_runtime on users -> users_self only            -> own row
--   nextup_auth    on users -> users_self OR users_auth   -> all rows
--
-- tests/auth-role.test.ts asserts exactly that asymmetry, in both directions.
-- ---------------------------------------------------------------------------
CREATE POLICY users_auth ON users
  TO nextup_auth
  USING      (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON users, sessions, accounts, verifications, rate_limits
  TO nextup_auth;

GRANT EXECUTE ON FUNCTION current_app_user() TO nextup_auth;
