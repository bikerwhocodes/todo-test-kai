# NextUp

A private, web-based task planner that helps freelancers and solo developers
choose a realistic, explainable daily plan.

> **Release 1.0.0 — account and data foundation.**
> This release delivers **no planning features**. There is no scheduler, no
> Inbox/Today/Upcoming view and no suggestion explanation. What it does deliver
> is the durable, private, owner-safe PostgreSQL foundation those features will
> stand on, with every structural guarantee covered by tests that run against a
> real database. Planning arrives in a later release.

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
# {"ok":true,"postgres":"17.11 (...)","migrationsApplied":3,
#  "role":"nextup_runtime","roleSafe":true}
```

`roleSafe: true` is the important field — see *Two database roles* below.

## Everyday commands

| Command | What it does |
|---|---|
| `npm test` | Full suite against the real database. Runs sequentially: one test restarts the database. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run db:migrate` | Apply pending migrations. Re-running is a no-op. |
| `npm run guard` | Assert the runtime role cannot bypass row-level security. |
| `npm run db:psql` | A `psql` shell using the container's own matching client. |
| `npm run db:reset` | **Destroys the local database volume** and rebuilds from empty. |
| `npm run db:down` | Stop the database, keeping its data. |

## How this is put together

### Two database roles

| Role | Owns tables | Used by | Superuser / BYPASSRLS |
|---|---|---|---|
| `nextup_owner` | yes | migrations only | no |
| `nextup_runtime` | **no** | the application | **no** |

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

54 tests against real PostgreSQL 17.11. No mocks and no in-memory substitute:
every guarantee in this release is a database guarantee, and a mock cannot
evidence one.

Isolation tests connect as **`nextup_runtime`**, the role the application
actually uses. A privilege test that passes as the owner or the superuser is
vacuous, so none are written that way. Fixtures use the superuser, because
`FORCE ROW LEVEL SECURITY` subjects even the owner to its policies.

## Not in this release

No scheduler or suggestions · no task-capture or planning UI · no
Inbox/Today/Upcoming/Projects views · no deployment or hosting · no
collaboration · no billing · no native apps · no external calendar integration
· no natural-language date parsing.

Sign-up, sign-in and sign-out are **not implemented here**. The identity tables
(`users`, `sessions`, `accounts`, `verifications`) are migrated in this release
in Better Auth's expected shape — with UUID ids and `timestamptz` instants
rather than the library's `text`/naive-timestamp defaults — so that wiring the
library is configuration rather than a schema rebuild. **Better Auth is
installed but not wired up, and nothing here has been exercised through it.**

The runtime role holds **no privileges on `sessions`, `accounts` or
`verifications`**. Those tables are read before a request has any identity
(looking a user up by email, a session up by token), which an `app.user_id`
policy cannot express. Protecting them needs a separate auth role, and that
belongs with the work that actually wires the auth library.
