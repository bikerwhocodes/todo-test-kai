# NextUp

A private, web-based task planner that helps freelancers and solo developers
choose a realistic, explainable daily plan.

> **Release 1.0.0 — in progress: account and data foundation.**
> This release delivers **no planning features yet**. There is no scheduler, no
> Inbox/Today/Upcoming view, no suggestion explanation and **no sign-in UI**.
> What it does deliver is the durable, private, owner-safe PostgreSQL
> foundation those features stand on, plus working email/password accounts
> with enforced account isolation — every structural and isolation guarantee
> covered by tests that run against a real database. Planning arrives later in
> this release.

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24.16.0+** | Pinned in `.nvmrc`. Runs the TypeScript sources directly — no build step for scripts or tests. |
| npm | 11.x | Lockfile is committed; use `npm ci` for a reproducible install. |
| Docker | 29.x + Compose v5 | Runs the pinned PostgreSQL. |
| PostgreSQL | **17.11** | Pinned in `docker-compose.yml`. Not installed locally — the container provides it. |

Running a **second clone** of this repository on the same machine needs one
extra step, because both clones otherwise publish port 55433 and derive the
same Compose project name from their directory name. Export the two overrides
*before* the first `npm run db:up`, so that the generated `.env.local` and the
container agree on the port:

```sh
export NEXTUP_DB_PORT=55434 COMPOSE_PROJECT_NAME=nextup-second
npm run db:up && npm run db:setup
```

`env:init` records both in `.env.local`, so later commands need no exports.
Symptoms of skipping this are `port is already allocated`, or a
`password authentication failed` immediately after a successful `db:setup` —
the second clone having reached the first one's database.

A local `psql` is **not** required. If you have one, note that a client older
than the server (for example Homebrew's 14.x) cannot `pg_dump`/`pg_restore`
against a 17 server; use `npm run db:psql`, which runs the container's own
matching client.

## Bootstrap

From a clean clone, four commands:

```sh
npm ci          # install exactly the locked dependency versions
npm run db:up   # generate .env.local, then start PostgreSQL 17.11
npm run db:setup # create the three database roles, then migrate
npm run dev     # http://127.0.0.1:3100
```

`npm run db:up` runs `npm run env:init` first, which writes a git-ignored
`.env.local` containing locally-generated random passwords. **No credential is
committed to this repository** — `.env.example` documents variable names only.
Re-running `env:init` never overwrites an existing `.env.local`.

Confirm it worked:

```sh
curl -s http://127.0.0.1:3100/api/health
# {"ok":true,"postgres":"17.11 (...)","migrationsApplied":4,
#  "role":"nextup_runtime","roleSafe":true}
```

`roleSafe: true` is the important field — see *Two database roles* below.

## Everyday commands

| Command | What it does |
|---|---|
| `npm test` | Full suite against the real database. Runs sequentially: one test restarts the database. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run db:migrate` | Apply pending migrations. Re-running is a no-op. |
| `npm run guard` | Assert the runtime role cannot bypass row-level security, and that RLS covers every user-scoped table. |
| `npm run db:psql` | A `psql` shell using the container's own matching client. |
| `npm run db:reset` | **Destroys the local database volume** and rebuilds from empty. |
| `npm run db:down` | Stop the database, keeping its data. |

## How this is put together

### Three database roles

| Role | Owns tables | Used by | Reaches | Superuser / BYPASSRLS |
|---|---|---|---|---|
| `nextup_owner` | yes | migrations only | everything | no |
| `nextup_runtime` | **no** | the application | the six user tables, plus **own-row only** on `users` | **no** |
| `nextup_auth` | **no** | `lib/auth.ts` only | `users`, `sessions`, `accounts`, `verifications`, `rate_limits` — and **nothing else** | **no** |

This split is load-bearing rather than tidy-minded. `ENABLE ROW LEVEL SECURITY`
does **not** constrain a table's owner: with `ENABLE` alone, the owner sees
every user's rows and every policy is silently inert. The protection is the
combination of `FORCE ROW LEVEL SECURITY` *and* connecting as a role that does
not own the tables and cannot bypass the policies.

Because that failure mode is silent — the application keeps working while
returning other people's data — `db/guard.ts` asserts the connected role is
safe and crashes loudly if it is not. `npm run guard` runs it, CI runs it, and
`/api/health` reports it. The guard also checks that **every** user-scoped
table carries `ENABLE` + `FORCE`, and that no table exists which is in neither
that list nor a documented exemption — because the realistic mistake is not a
misconfigured connection but a new table shipped with no policy.

**Why `nextup_auth` is a third role rather than wider grants on
`nextup_runtime`.** Sign-in has to read a user by email and a session by its
cookie token *before* the request has any identity, so an `app.user_id` policy
cannot express it. Widening the runtime role to cover those tables would hand
every application query the ability to read every session token in the
database. Instead the privilege lives in one role used by one file, and the two
roles' grants are disjoint: application code cannot read a session token, and
the auth library cannot read anyone's tasks. `users` keeps `FORCE` row-level
security, with a second policy scoped `TO nextup_auth` so the widened view
cannot leak to the runtime role — enforced by Postgres, not by remembering to
filter. Tests assert both denials directly, as each role.

### Request identity

Every query runs inside `withUser()` (`db/client.ts`), which opens a
transaction and binds the caller's id with
`set_config('app.user_id', $1, true)`. The `true` is `SET LOCAL`: identity ends
with the transaction, so it cannot outlive the request and leak to whoever
borrows the same pooled connection next. There is a test for exactly that, on a
single-connection pool.

The policies read identity through `nullif(current_setting('app.user_id', true), '')`.
The `nullif` matters: unset, `current_setting` returns an **empty string**, and
casting `''` to `uuid` *raises* rather than denying — turning a missing identity
into a 500 instead of an empty result. Wrapped, the policy fails closed.

### Accounts and sessions

Email and password, via Better Auth 1.7.7 mounted at `/api/auth/*`.

| Property | Choice |
|---|---|
| Password hashing | **scrypt** (Better Auth's default, native `node:crypto`). The PRD *proposed* Argon2id; scrypt is the recorded decision. A9 is satisfied **by scrypt** — do not read it as an Argon2id claim. |
| Ids | `uuid`, via `advanced.database.generateId: "uuid"`. The library's default base62 string would be rejected by the `uuid` columns. |
| Sessions | Rows in `sessions`, 7-day expiry. Sign-out **deletes the row**, so a kept cookie cannot be replayed. |
| Cookies | `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` in production. Asserted by test rather than assumed. |
| CSRF | On. One explicit `trustedOrigins` entry; `disableCSRFCheck` is never set. |
| Rate limiting | On **in every environment** (the library default disables it in development), persisted in `rate_limits`, 100/min generally and 5/min on sign-in and sign-up. |

**Another user's resource returns `404`, never `403`.** A 403 confirms that the
resource exists, which is an enumeration oracle. `lib/http.ts` has no 403 in
its status table, so a handler cannot return one by accident, and a test fails
the build if `403` appears anywhere in `lib/`, `db/` or `src/`.

Isolation is two independent layers: every repository function in `db/` takes
the caller's id as its **first** parameter and adds `AND user_id = $n`, and
row-level security enforces the same thing underneath. A test asserts the
second layer alone still blocks a cross-owner read, so the application
predicate is a redundancy rather than the only thing holding.

**No sign-in UI yet.** The endpoints work and are tested; the forms are a later
item.

### Owner-safe relationships

Owner safety is structural, not a convention the application has to remember.
Each table carries `UNIQUE (id, user_id)`, and children reference parents by the
**pair**:

```sql
CONSTRAINT tasks_project_owner_fk FOREIGN KEY (project_id, user_id)
  REFERENCES projects (id, user_id)
```

A task belonging to user A therefore *cannot* reference user B's project: no
such `(id, user_id)` row exists. Because `user_id` is `NOT NULL`, every non-null
reference is fully checked, while a `NULL` reference (`MATCH SIMPLE`) correctly
means "no project". The extra unique key per table is the deliberate cost.

### Dates vs instants

Calendar dates (`deadline`, `plan_date`, `occurrence_date`, `start_date`) are
`date`. Audit instants (`created_at`, `completed_at`, `accepted_at`) are
`timestamptz`. A calendar date is never a local-midnight timestamp: stored that
way, "9 October" written for an Auckland user reads back as 8 October in
Edmonton. `tests/dates.test.ts` demonstrates that off-by-one directly, next to
the `date` column that is immune to it.

Each user stores an IANA zone identifier (never a fixed offset — a check
constraint and a trigger both reject one), and "today" is derived server-side
from it.

### Plan membership is not a deadline

`tasks` has no `plan_date` and no `planned_for_today` column. Membership of a
day's plan exists **only** in `day_plan_items`, so planning a task for today
structurally cannot change when it is actually due. A test walks a whole plan
lifecycle and asserts no task's `deadline` or `updated_at` moves.

### Migrations are hand-written SQL

`db/migrations/*.sql`, applied in filename order, each in its own transaction,
recorded in `schema_migrations`. Append-only: to change the schema, add a file.

Drizzle is the **typed query layer** (`db/schema.ts`), not the migration source.
The load-bearing parts of this schema are things a generator either cannot emit
or would quietly reshape — composite foreign keys with an `ON DELETE SET NULL`
column list, partial unique indexes with predicates, triggers, RLS policies and
role grants — and each was validated against a real PostgreSQL before being
written. Hand-authored SQL keeps them exact. `tests/schema-drift.test.ts`
asserts `db/schema.ts` and the live database still agree, so the two mirrors
cannot drift apart unnoticed.

## Two traps worth knowing before you edit the schema

**Partial unique indexes and `ON CONFLICT`.** Occurrence uniqueness uses a
*partial* index (a plain `UNIQUE` over nullable columns permits unlimited
duplicates). Conflict inference cannot see a partial index unless you **restate
its predicate**:

```sql
ON CONFLICT (recurrence_rule_id, occurrence_date)
  WHERE recurrence_rule_id IS NOT NULL AND occurrence_date IS NOT NULL
  DO NOTHING
```

Omit the `WHERE` and it fails at runtime on the first call. A test asserts the
omitted form still fails, so the correction cannot quietly regress.

**Cycle detection carries no depth bound.** `db/dependencies.ts` deduplicates on
`id` alone. Adding a `depth` column would reintroduce a cutoff — a `depth < 64`
variant reports "no cycle" for a real cycle on a 70-link chain, admitting the
thing it exists to reject. The search is also wrapped in a per-user
`pg_advisory_xact_lock`: without it, two individually-acyclic concurrent writes
both commit and jointly create a cycle. Both facts have tests, including a
control that shows the unlocked path corrupting the graph.

## Testing

```sh
npm test
```

83 tests against real PostgreSQL 17.11. No mocks and no in-memory substitute:
every guarantee here is a database or an auth guarantee, and a mock cannot
evidence one.

Isolation tests connect as **`nextup_runtime`**, the role the application
actually uses, and the auth-role denials connect as **`nextup_auth`**. A
privilege test that passes as the owner or the superuser is vacuous, so none
are written that way. Fixtures use the superuser, because `FORCE ROW LEVEL
SECURITY` subjects even the owner to its policies.

The account tests sign real accounts up and in through Better Auth's own
handler and then call the route handlers directly, in process — the same entry
points the app uses, so cookies, CSRF checks, rate limiting, scrypt hashing and
every database write are real. **There is no browser in the loop**: no
Playwright, no real cross-origin request, no UI. Browser-level behaviour is
therefore unverified.

The suite was mutation-tested rather than only observed passing. Returning 403
instead of 404 fails three tests; granting the runtime role `SELECT` on
`sessions` fails one; sourcing identity from anything but the signed cookie
fails twelve. Two gaps that exercise found are now closed by tests of their
own: a forged or tampered session cookie, and the row-level-security backstop
holding when a repository forgets its `AND user_id` predicate.

## Not built yet

No scheduler or suggestions · no task-capture or planning UI · no
Inbox/Today/Upcoming/Projects views · no deployment or hosting · no
collaboration · no billing · no native apps · no external calendar integration
· no natural-language date parsing.

**No UI for sign-up, sign-in or sign-out.** The endpoints exist, work and are
tested; the forms are a later item.

**Only `/api/projects` exists.** It is here because proving "another user's
resource is a 404" needs at least one real read-by-id route. Tasks,
dependencies, recurrence rules and plans have no HTTP routes yet; when they
arrive they inherit the same `requireUser()` + first-parameter-is-the-owner
pattern, which is what is proven here.

**No password reset and no email verification**, by decision rather than
oversight: a forgotten password means a lost account. Also absent: MFA, account
deletion and export, and brute-force lockout beyond rate limiting.

**No migration rollback.** Migrations are forward-only and append-only; there
is no `down` script and none is faked. Local recovery is `npm run db:reset`,
which destroys the volume.
