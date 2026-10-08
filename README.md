# NextUp

A private, web-based task planner that helps freelancers and solo developers
choose a realistic, explainable daily plan.

> **Release 1.0.0 — account and data foundation, plus accounts and isolation.**
> This release delivers **no planning features**. There is no scheduler, no
> Inbox/Today/Upcoming view and no suggestion explanation. What it does deliver
> is the durable, private, owner-safe PostgreSQL foundation those features will
> stand on, and working **sign-up, sign-in and sign-out** on top of it, with
> every structural guarantee covered by tests that run against a real database.
> Planning arrives in a later release.

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24.16.0+** | Pinned in `.nvmrc`. Runs the TypeScript sources directly — no build step for scripts or tests. |
| npm | 11.x | Lockfile is committed; use `npm ci` for a reproducible install. |
| Docker | 29.x + Compose v5 | Runs the pinned PostgreSQL. |
| PostgreSQL | **17.11** | Pinned in `docker-compose.yml`. Not installed locally — the container provides it. |

A local `psql` is **not** required. If you have one, note that a client older
than the server (for example Homebrew's 14.x) cannot `pg_dump`/`pg_restore`
against a 17 server; use `npm run db:psql`, which runs the container's own
matching client.

## Bootstrap

From a clean clone, four commands:

```sh
npm ci          # install exactly the locked dependency versions
npm run db:up   # generate .env.local, then start PostgreSQL 17.11
npm run db:setup # create the two database roles, then migrate
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
#  "role":"nextup_runtime","roleSafe":true,"schemaSafe":true}
```

`roleSafe` and `schemaSafe` are the important fields — see *Three database
roles* below. The server also refuses to start at all if either is false
(`instrumentation.ts`), so a deployment pointed at an unsafe role crashes
instead of quietly serving everyone's data.

If you already had a `.env.local` from an earlier checkout, `npm run env:init`
**adds** the variables this release introduced (`AUTH_DATABASE_URL`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXTUP_AUTH_PASSWORD`) without
touching the passwords already in it.

## Everyday commands

| Command | What it does |
|---|---|
| `npm test` | Full suite against the real database. Runs sequentially: one test restarts the database. |
| `npm run test:tz` | **The same suite again, east of UTC** (`TZ=Pacific/Auckland`). Not redundant — see *Why the suite runs twice*. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run db:migrate` | Apply pending migrations. Re-running is a no-op. |
| `npm run guard` | Assert the runtime role cannot bypass row-level security. |
| `npm run db:psql` | A `psql` shell using the container's own matching client. |
| `npm run db:reset` | **Destroys the local database volume** and rebuilds from empty. |
| `npm run db:down` | Stop the database, keeping its data. |

## How this is put together

### Three database roles

| Role | Owns tables | Used by | Reaches | Superuser / BYPASSRLS |
|---|---|---|---|---|
| `nextup_owner` | yes | migrations only | everything | no |
| `nextup_runtime` | **no** | every ordinary request | the 6 domain tables + its **own** `users` row | **no** |
| `nextup_auth` | **no** | `lib/auth.ts` only | the 4 identity tables + `rate_limits` | **no** |

**Neither application role is a superset of the other.** The runtime role
cannot read a single session token; the auth role cannot read a single task.
That is the whole point: a flaw in either layer reaches strictly less than the
whole, and `db/guard.ts` asserts **both** directions at startup, so a later
migration that widens either one fails the boot rather than passing review.

The auth role exists because Better Auth must look a user up by email and a
session up by token **before a request has any identity**. An `app.user_id`
policy cannot express that — with no identity set it denies every row, which is
correct for domain data and fatal for login. The tempting fix is to grant the
runtime role what the auth library needs; that was rejected, because it would
give the code serving ordinary task requests permanent access to every user's
row and every session token. See `db/migrations/004_auth_role.sql`.

`users` is where the two roles meet, and the policies are asymmetric by role:
`users_self` confines the runtime role to its own row, while `users_auth`
(scoped `TO nextup_auth`) permits the pre-identity lookup. Permissive policies
are OR'd and a `TO` clause limits which roles see a policy at all, so adding
the second one widens nothing for the first. `tests/auth-role.test.ts` observes
that asymmetry rather than assuming it.

This split is load-bearing rather than tidy-minded. `ENABLE ROW LEVEL SECURITY`
does **not** constrain a table's owner: with `ENABLE` alone, the owner sees
every user's rows and every policy is silently inert. The protection is the
combination of `FORCE ROW LEVEL SECURITY` *and* connecting as a role that does
not own the tables and cannot bypass the policies.

Because that failure mode is silent — the application keeps working while
returning other people's data — `db/guard.ts` asserts the connected role is
safe and crashes loudly if it is not. `npm run guard` runs it, CI runs it, and
`/api/health` reports it.

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

Email + password through **Better Auth 1.7.7**, configured against the schema
rather than generating its own: the adapter is handed an explicit
singular-to-plural model map, so nothing depends on the adapter's `usePlural`
string munging and a renamed table fails to typecheck instead of failing at the
first sign-in.

| Control | What runs |
|---|---|
| Password hashing | Better Auth's built-in **scrypt** (`node:crypto`). PRD A9 *proposed* Argon2id; what actually runs is scrypt, by decision, and a test asserts the stored form so this claim is checked rather than assumed. |
| Sessions | Rows in `sessions`. Logout **deletes the row**, so a replayed cookie is dead even though it is still a valid signature. Expiry is enforced server-side from the row. |
| Cookies | `HttpOnly`, `SameSite=Lax`, and `Secure` whenever `NODE_ENV=production`. |
| CSRF | Origin checked against `trustedOrigins`; a cross-origin credential POST gets `403 INVALID_ORIGIN` and no session. |
| Rate limiting | Enabled **explicitly** — the library default is off in development, which would have made the rate-limit test pass against no limiter. Counters live in `rate_limits` (Postgres), not process memory, because in-memory state is per-instance and therefore not a limit behind more than one server. Credential endpoints get 5/minute against the general 100/minute. |
| Password reset | **Not implemented**, by conscious decision. A forgotten password is a lost account in this release. |

Account creation belongs to the auth role: the runtime role has **no `INSERT`
on `users`**, so the application cannot mint accounts outside the auth path.

### Why the suite runs twice

CI runs the whole suite a second time under `TZ=Pacific/Auckland`, because a
calendar-date bug is **invisible at UTC and wrong in roughly half the world**.
That is not hypothetical: `date` columns were being serialised with
`toISOString()`, which re-reads a local-midnight `Date` in UTC and so reports
the **previous day** for every positive offset. A task stored with
`deadline = 2026-12-01` came back as `2026-11-30` in Auckland and Berlin, and
looked perfect in UTC and Edmonton.

A UTC-only runner **structurally cannot** catch that class, so the second run
is the guard, not the test. The suite is ~30s; the insurance is cheap.

`pg` parses a `date` into a `Date` at local midnight. Read it back with local
components (or cast to `::text` in SQL) — never `toISOString()`.

### Another user's id returns 404, never 403

A `403` confirms the row exists, which is exactly the enumeration oracle the
isolation design exists to deny. "Missing" and "not yours" are therefore the
same answer, produced by one helper (`lib/http.ts`) so they cannot drift apart
as endpoints are added. There is **no 403 anywhere in this API**, and a test
asserts the forbidden and nonexistent responses are byte-identical.

Every repository function takes the caller's user id alongside the row id —
there is no `getTask(id)` to call by mistake, so the unscoped query is not
expressible. RLS is the independent backstop beneath it, and the composite
foreign keys make a cross-owner *link* unrepresentable rather than merely
unauthorized.

**A malformed id gets the same 404.** `GET /api/tasks/abc` used to reach
Postgres, raise `22P02 invalid input syntax for type uuid`, and surface as a
**500** on eight endpoints. It is now 404 — and deliberately **not** 422, since
a 422 would reveal that an id was at least well-formed, which is the
enumeration oracle in miniature. Malformed, foreign and nonexistent ids are all
answered identically. The check lives in the repository, not in each route, so
a new route cannot forget it.

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

94 tests against real PostgreSQL 17.11. No mocks and no in-memory substitute:
every guarantee in this release is a database guarantee, and a mock cannot
evidence one. Auth tests go through the real library against the real database
— no hand-inserted session rows, because a hand-made session would prove
nothing about Better Auth.

Isolation tests connect as **`nextup_runtime`**, the role the application
actually uses. A privilege test that passes as the owner or the superuser is
vacuous, so none are written that way. Fixtures use the superuser, because
`FORCE ROW LEVEL SECURITY` subjects even the owner to its policies.

## Not in this release

No scheduler or suggestions · no task-capture or planning UI · no
Inbox/Today/Upcoming/Projects views · no deployment or hosting · no
collaboration · no billing · no native apps · no external calendar integration
· no natural-language date parsing.

Sign-up, sign-in and sign-out **do** work now, and so does two-account
isolation across every endpoint below. What is still missing on the account
side is deliberate: **no password reset, no email verification, no MFA, no
account deletion or export, and no audit trail of data changes.** A forgotten
password is a lost account in this release.

The HTTP surface is deliberately the minimum that lets account isolation be
*proven* end to end, not the full API:

| Implemented | Still to come |
|---|---|
| `/api/auth/*`, `/api/me` | — |
| `/api/projects`, `/api/projects/:id` | archive/unarchive, open counts |
| `/api/tasks`, `/api/tasks/:id` | complete/reopen, subtask listing, search and filter |
| `/api/tasks/:id/dependencies` (POST) | DELETE an edge |
| — | every `/api/plan*`, `/api/recurrence*` endpoint |
| — | the `?view=inbox\|today\|upcoming\|project` query shapes |

### Correctness behaviour NOT verified

- **Calendar dates are verified at two offsets only** — UTC/Edmonton (negative)
  and Auckland/Berlin (positive). No test runs at a **half-hour** offset
  (`Asia/Kolkata`) or across a DST boundary *in the serialisation layer*;
  NEXT-1's storage-level DST tests are separate and still pass.
- **Malformed-id handling is verified on the seven id-bearing endpoints that
  exist.** Phase 2's endpoints inherit the repository guard automatically, but
  inheriting it is not the same as testing it.

### Security behaviour NOT verified

Stated plainly, because an unverified control that is *assumed* to work is
worse than a missing one:

- **No rollback path for migrations.** Forward-only and append-only; there is
  no `down` script and none is faked.
- **`Secure` cookie flag under a real HTTPS origin.** Verified only that
  `next start` (`NODE_ENV=production`) emits `Secure` over plain HTTP on
  localhost. No TLS deployment exists to test against.
- **Rate limiting under concurrency, and its IP attribution behind a proxy.**
  Verified sequentially on a single host. When no client IP can be resolved,
  Better Auth buckets requests under a single `no-trusted-ip` key — behind a
  load balancer that would need `advanced.ipAddress.ipAddressHeaders` set, and
  that is untested here.
- **Session fixation across a privilege change**, concurrent logout races, and
  cookie behaviour across subdomains.
- **No load testing, no penetration testing, and no deployment of any kind.**
