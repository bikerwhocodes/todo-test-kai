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
| `pnpm test:isolation` | Just the account isolation suite (`tests/integration/isolation`) |
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

## Tasks and projects

- Tables `projects`, `tasks`, `subtasks` (`drizzle/0001_tasks_projects.sql`). Every row has
  `user_id`; tasks reference projects and subtasks reference tasks through composite
  `(user_id, id)` foreign keys, so the database rejects cross-account links even if app code
  slips.
- A task with `project_id = null` is in the Inbox. `completed_at` is set exactly when
  `status = 'done'` (a CHECK constraint), so reopening always clears it.
- Archiving a project hides it from the nav and project pickers; its tasks stay put. Tasks
  can't be created in or moved into an archived project.
- Data access lives in `src/server/repo/*`: every function takes `userId` first and scopes
  every query by it. Another user's rows behave exactly like missing ones (`NotFoundError`).
- **Upcoming** (`/upcoming`) shows open tasks with a deadline. An Overdue group comes first, then one group for each
  date from today through today + 13. **Today** has a Plan section, which stays empty until Plan My Day ships, and a
  "Due today & overdue, not in plan" section. "Today" is the date in the user's profile zone
  (`user_settings.time_zone`). Deadlines are compared only as dates (`src/core/agenda.ts`,
  `src/server/repo/agenda.ts`).
- Server actions (`src/server/actions/{tasks,projects}.ts`) take `unknown`, validate with the
  zod schemas in `src/lib/validation.ts` and return `{ ok, data } | { ok: false, error }`.
  For optional task fields, `null` clears the value and an omitted key leaves it unchanged.

## Dependencies ("Blocked by")

- Table `task_dependencies` (`drizzle/0002_task_dependencies.sql`): a row
  `(user_id, task_id, blocked_by_task_id)` means "task waits on blocked_by". Both ends are
  composite `(user_id, id)` foreign keys into `tasks` with `ON DELETE CASCADE`, so an edge can
  only join two tasks of the same user and disappears with either task. A CHECK forbids self-edges.
- Blocked-ness is derived, never stored: a task is blocked iff any direct blocker is `open`
  (`blockedSet` in `src/core/graph`). Completing the blocker unblocks it; reopening blocks it again.
- `addBlockerAction` runs in one transaction: a per-user advisory lock
  (`pg_advisory_xact_lock(ns, hashtext(user_id))`), then both tasks are checked to be the
  caller's (and `FOR KEY SHARE`-locked), then the user's edges are loaded and
  `wouldCreateCycle` decides. A loop is refused with a message naming it ("That would create a
  loop: "A" waits on "B", which waits on "A".") and nothing is saved. Adding an existing link
  and removing a missing one are no-ops.
- List views load every listed task's blockers in one query.

## Search

`/search` (in the nav after Inbox) finds the user's tasks by text and filters. All filters are
ANDed in one SQL query (`src/server/repo/search.ts`), scoped by `user_id` like every repo function.
The URL is the state: the filter bar rewrites it with `router.replace` (text after 250 ms, selects
at once), so reload, back/forward and shared links show the same search. Without JavaScript it is a
plain `GET` form. `src/core/search.ts` parses and writes the params; invalid values are dropped,
never an error, and written URLs are canonical (fixed key order, defaults left out).

| Param | Values | Omitted |
|---|---|---|
| `q` | Case-insensitive substring of title or notes (one phrase; `%`, `_`, `\` match literally). Trimmed, whitespace collapsed, max 200 characters. | No text filter |
| `project` | A project id (archived ones too), or `inbox` | All projects |
| `priority` | `1`–`4` (`4` = none) | Any |
| `status` | `open`, `done`, `skipped`, `all` | `open` |
| `due` | `overdue` (open, deadline before the user's local today), `has`, `none` | Any |
| `blocked` | `1`: open and waiting on an open blocker; `0`: everything else | Either |
| `estimate` | `1`: has an estimate; `0`: has none | Either |

Results are open tasks first, then by priority, deadline (none last) and age, capped at 200 with a
note when there are more. Another user's project id matches nothing and isn't shown back.

Press `/` anywhere in the app (outside text fields and dialogs) to focus the search box, or to open
`/search` from another page. `Escape` leaves the search box.

## Keyboard

Everything works without a mouse. `?` (or "Shortcuts" in the header) lists the shortcuts. They are
off while typing in a field, with Ctrl/Meta/Alt held, and inside dialogs. The rules are in
`src/core/shortcuts.ts`; `src/components/keyboard/` wires them to the page.

- `g` then `i` / `t` / `u` goes to Inbox / Today / Upcoming (within 1.5 s; any other key cancels).
  `g p` focuses the current project's sidebar link, else the first; with no projects it opens
  "New project".
- `j` / `k` move focus down / up through the task rows on the page (all groups, skipping a closed
  "Completed"). The focused row is highlighted.
- `x`, or Space on a row, completes or reopens it. When the row moves (into "Completed", off
  Today), focus goes back to it, or to the row now in its place if it's hidden.
- `e` (or Enter) opens the row's editor; `e` also puts the cursor in the title. `Escape` closes it
  and returns focus to the row.
- `q` / `n` focus quick add. Pages without one go to Inbox and focus its quick add once it
  renders.
- `p` opens Plan My Day (below). `g p` is still Projects.

## Plan My Day

Server side (`src/server/repo/plans.ts`, `src/server/actions/plans.ts`, ranking in `src/core/scheduler`):

- `suggestPlanAction({ availableMin })` drafts today's plan and saves nothing. Besides the
  suggestions, didn't-fit and nothing-fits lists, the draft has `blocked`: each open task left out
  because it waits on an open task, with `waitingOn`, the titles of its open direct blockers.
  It is built from the rows and edges the draft already loaded, so it costs no extra query. Both
  lists are in task order (sort, then creation).
- `acceptPlanAction({ taskIds, availableMin?, manualTaskIds? })` appends to today's plan. Ids
  that are also in `manualTaskIds` (added by search or "Add anyway") are saved with source
  `manual`, the rest `suggested`. A manual id that isn't in `taskIds` is ignored.
- `rememberAvailableTimeAction({ availableMin })` stores the last custom time in
  `user_settings.last_available_min` so the panel can prefill it. It writes nothing else.
- `listOpenTasksForPlanning(userId)` lists open tasks (`id`, `title`, `estimateMin`,
  `projectId`) for the panel's "Add a task" search.
- `explainReasons(reasons, max = 2)` and `explainSize(size)` in `core/scheduler/explain.ts`
  turn reason codes into labels ("Overdue by 2 days", "Priority 1", "Needs 45m; 20m left"):
  most points first, zero-point reasons only in free slots, never empty.
- Keyboard: `p` on `/today` dispatches `OPEN_PLAN_EVENT` on `window`; on any other page it goes
  to `/today?plan=1` (`src/components/plan/events.ts`). Shortcuts stay off inside the panel's
  dialog, like every dialog.

## Plan My Day panel

"Plan my day" on Today (in the Plan header and the empty state) opens the panel, a native
`<dialog>`: full screen on phones, a sheet on the right from `sm` up. It also opens on the
`nextup:open-plan` window event and on `/today?plan=1` (the param is then removed). The rules
(durations, totals, moves, search) are pure functions in `src/components/plan/model.ts`.

1. **Time**: 1h, 2h, 4h or a custom time ("90", "90m", "1h 30m", "1.5h"; 1 minute to 24h). A custom
   time is remembered and prefilled next time.
2. **Review**: today's saved plan ("Planned"), then the draft (suggestions with 1–2 reasons, and
   tasks "Added by you"). The total reads "1h 45m planned of 2h"; past the time it says "25 min
   over", calmly, and accepting is still allowed. Done tasks are struck through and not counted;
   tasks without an estimate count at the default estimate. "Didn't fit" offers "Add anyway" and
   "Split" (makes "<title> (part 1)" with the original's priority and deadline); "Blocked" lists
   what each task waits on.

Saved-plan edits (remove, reorder, estimates) save at once. Removing a suggestion or a planned task
also hides it from today's suggestions. "Add N to plan" saves the draft; "Cancel" drops it.

| Key | On a focused row |
|---|---|
| `Alt`+`↑` / `Alt`+`↓` | Move it up / down within its group (announced, focus stays on it) |
| `Backspace` / `Delete` | Remove it |
| `Enter` on the estimate | Edit the estimate; `Enter` saves, `Esc` cancels |

`↑` / `↓` and `Enter` pick from the "Add a task" matches. `Esc` first cancels an estimate edit or clears the
search, otherwise it closes the panel and returns focus to the button that opened it. `Ctrl`/`⌘`+`Enter` accepts. Rows can also be
dragged by their ⠿ handle.

## Account isolation

One account must never read or change another's data. `tests/integration/isolation/` proves it
with two real signed-up users, A and B, who each own one of everything (`world.ts`):

- `actions.test.ts` signs in as B and calls every server action with A's ids (task, project and
  subtask ids, and B's own task aimed at A's project). Each must return exactly
  `{ ok: false, error: "<Entity> not found" }`, the same answer as for an id that doesn't exist,
  and leave a snapshot of every row A owns, in every user-owned table, byte-identical.
- `pages.test.ts` calls each app page and layout as B: A's ids are a 404, and nothing of A's
  (ids, names, email, time zone) appears in what the page passes to its components.
- `routes.test.ts` calls each route handler as B (today the Better Auth endpoints).
- `repo.test.ts` covers `src/server/repo/*` and the composite foreign keys.
- `coverage.test.ts` fails the build when something isn't in `registry.ts`: a table in the
  database or Drizzle schema, a `user_id` table not in `USER_OWNED_TABLES`, an exported server
  action, a `route.ts`, or a page/layout. The failure says what to add and where.

**Definition of done:** a story that adds a user-owned table, server action, route handler or
page registers it in `tests/integration/isolation/registry.ts` with cross-user cases (or an
exemption saying why it can't reach user data) and seeds new tables in `world.ts`. CI runs the
suite as its own "Account isolation suite" step. Later epics (dependencies, series, plans) extend
the same registry.

## Known gaps

- `drizzle/0000_auth.sql`, `drizzle/0001_tasks_projects.sql` and `drizzle/0002_task_dependencies.sql` were written by hand (no
  registry access when they were created) and the `drizzle/meta/*_snapshot.json` files are
  missing. Before the next schema change, run
  `pnpm db:generate` once on a clean checkout, check it matches the hand-written migrations, and
  commit the generated snapshot; otherwise drizzle-kit will try to recreate every table.
- `pnpm-lock.yaml` is not committed yet; CI installs with `--no-frozen-lockfile` until it is.
