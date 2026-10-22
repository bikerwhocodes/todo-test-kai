# todo-test-kai

NextUp: a to-do app with an explainable "Plan My Day".

## Data layer

- `src/server/db/schema.ts` defines the Drizzle schema. Migrations are SQL files in `src/server/db/migrations/`, written by hand, and must be kept in sync with the schema.
- Every user-owned table has a `user_id` column. Child rows reference their parent through a composite `(user_id, id)` foreign key, so Postgres itself rejects a task that points at another user's project, or a subtask that points at another user's task.
- `src/server/repo/` contains the only data access. Every method takes `userId` as its first argument and scopes every query by it. A row owned by another user is treated the same as a row that doesn't exist (`null` / `false` / `NotFoundError`).

## Commands

```sh
npm install
npm run typecheck
npm test                                  # unit tests
DATABASE_URL=postgres://... npm run db:migrate
DATABASE_URL=postgres://... npm run test:integration
```

Integration tests create a throwaway database (`nextup_test_*`) on the server named by `DATABASE_URL`, migrate it from empty, and drop it afterwards. The role therefore needs `CREATEDB`. CI runs them against a Postgres 16 service.
