# NextUp

A calm to-do app with an explainable "Plan My Day". Next.js (App Router) + Postgres/Drizzle + Better Auth.

## Getting started

```sh
cp .env.example .env.local   # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm install
createdb nextup && createdb nextup_test
pnpm db:migrate              # uses DATABASE_URL
pnpm dev
```

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit tests (no database) |
| `pnpm test:integration` | Integration tests against `TEST_DATABASE_URL` (migrated and truncated) |
| `pnpm db:generate` | Generate a SQL migration from `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations in `drizzle/` |

## Auth

- Email + password through Better Auth (`src/server/auth.ts`), mounted at `/api/auth/*`.
  Passwords are hashed with scrypt. Sessions are rows in `sessions`; the browser holds
  only an httpOnly, SameSite=Lax cookie (Secure when `BETTER_AUTH_URL` is https).
- Signup sends the browser's IANA time zone; a `user.create.after` hook stores it in
  `user_settings` (invalid or missing zones become `UTC`, `default_estimate_min` = 30).
- `src/proxy.ts` redirects requests without a session cookie to `/login?next=…`. Every
  route except `/login`, `/signup` and `/api/auth/*` is protected by default.
- The proxy only checks that a cookie exists. **Every app page, server action and route
  handler must call `requireUser()`** (`src/server/session.ts`), which validates the session
  against the database.
- Rate limits are stored in Postgres (`rate_limits`) and keyed by client IP and path:
  5 sign-ins/minute, 5 sign-ups/10 minutes, 100 requests/minute for other auth endpoints.
  By default only a single-hop `X-Forwarded-For` is trusted; if the IP can't be resolved,
  all clients share one bucket. In production set `AUTH_IP_HEADERS` to the header your host
  guarantees (e.g. `x-real-ip`, `cf-connecting-ip`), or `AUTH_TRUSTED_PROXIES`
  (comma-separated IPs/CIDRs) to read the client from a multi-hop `X-Forwarded-For`.

## Known gaps

- `drizzle/0000_auth.sql` was written by hand (no registry access when it was created) and
  `drizzle/meta/0000_snapshot.json` is missing. Before the next schema change, run
  `pnpm db:generate` once on a clean checkout, check it matches `0000_auth.sql`, and commit the
  generated snapshot; otherwise drizzle-kit will try to recreate every table.
- `pnpm-lock.yaml` is not committed yet; CI installs with `--no-frozen-lockfile` until it is.
