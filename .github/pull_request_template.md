## What and why

<!-- What changes for the user, and the story/issue it belongs to. -->

## Definition of done

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm test:integration` pass (CI runs them, plus `pnpm build`)
- [ ] Every new page, layout, server action and route handler calls `requireUser()` and scopes every query by the user's id
- [ ] New user-owned table / server action / route / page added to the isolation suite registry (`tests/integration/isolation/registry.ts`) with cross-user cases or a reasoned exemption, and new tables seeded for both users in `tests/integration/isolation/world.ts`
- [ ] Schema changes come with a migration in `drizzle/`
- [ ] README updated if behaviour, setup or architecture changed

## Notes for reviewers

<!-- Anything risky, follow-ups, screenshots. -->
