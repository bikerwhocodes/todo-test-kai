# src/core

Pure domain logic with no I/O. Code here must not import from `server/` or `app/`, read the clock, or read the environment. Callers pass in `now` and `tz`.

## Dates (`core/dates.ts`)

All domain dates are floating `IsoDate` strings (`YYYY-MM-DD`) with no time or zone.

| Function | Notes |
|---|---|
| `localToday(tz: string, now: Date): IsoDate` | The user's wall-clock date. Throws `RangeError` for an unknown zone or an invalid `Date`. |
| `addDays(date, n)`, `diffDays(from, to)` | Day-number arithmetic, so DST can't affect it. |
| `weekdayOf(date): Weekday` | 0 = Sunday … 6 = Saturday, the same as Postgres `EXTRACT(DOW)`. |
| `startOfIsoWeek(date)` | Monday on or before `date`. |
| `compareIsoDate`, `maxIsoDate`, `minIsoDate` | Validate their inputs. |
| `isIsoDate(v)`, `assertIsoDate(v)`, `isValidTimeZone(tz)` | Input guards for server actions and zod refinements. |

## Recurrence (`core/recurrence`)

```ts
type RecurrenceRule =
  | { kind: "daily";  interval: number; startDate: IsoDate; endDate?: IsoDate | null }
  | { kind: "weekly"; interval: number; weekdays: Weekday[]; startDate: IsoDate; endDate?: IsoDate | null };
```

| Function | Notes |
|---|---|
| `validateRule(rule): string[]` | Returns an empty array when the rule is valid. `interval` must be 1–365, `weekdays` must be non-empty, and `endDate >= startDate`. |
| `firstOccurrence(rule): IsoDate \| null` | The earliest matching date on or after `startDate`. |
| `nextOccurrence(rule, after): IsoDate \| null` | The earliest occurrence strictly after `after`. Returns `null` after `endDate`. |
| `nextOccurrenceAfterCompletion(rule, occurrenceDate, today)` | Use this on completion. The result is always later than `max(occurrenceDate, today)`, and overdue dates are not back-filled. |
| `occurrencesBetween(rule, from, to, limit = 1000)` | Inclusive range, for previews. |

Semantics:
- The schedule is fixed. It is anchored at `startDate` (Todoist's `every`, not `every!`).
- Weekly rules use Monday-based weeks. Week 0 is the week that contains `startDate`, and every `interval`-th week after that is active.
- Invalid rules or dates throw `RangeError`.

## Graph (`core/graph`)

| Function | Notes |
|---|---|
| `wouldCreateCycle(edges, taskId, blockedById): boolean` | Run this before inserting an edge. Self-edges count as cycles. |
| `blockedSet(tasks, edges): Set<TaskId>` | A task is blocked if any of its direct blockers is open. |

## Scheduler (`core/scheduler`)

`suggestPlan()` filters, scores and ranks the candidates (step 1), then fits them greedily into the time available (step 2).

| Function | Notes |
|---|---|
| `rankCandidates(input): { ranked, excluded }` | `input` is `{ today, tasks, edges, inPlanIds?, dismissedIds?, carriedOverIds?, defaultEstimateMin? }`. Pass `today = localToday(tz, now)`. |
| `scoreTask(task, ctx)` | One task against the score table. Returns `score`, `reasons`, `estimateMin` and `dueDate`. |
| `compareCandidates(a, b)` | The ranking order, also exported for the fit step. |
| `suggestPlan(input): Draft` | `input` is the `rankCandidates` input plus `availableMin`. Returns `{ suggestions, didntFit, nothingFits, totals, excluded }`. Saves nothing. |

- **Excluded** (the first match wins): not open (`done`), already in today's plan (`in_plan`), dismissed today (`dismissed`), a recurring occurrence dated after today (`future_occurrence`), blocked by an open task (`blocked`). Blocked tasks are never ranked. Pass every open blocker in `tasks`, because missing blockers count as done.
- **Score**: the sum of the rows in `scheduler/weights.ts`, the only place weights live. The due date is `deadline ?? occurrenceDate`.
- **Order**: higher score first. Ties go to the earlier due date (no due date last), then the higher priority, then the shorter estimate, then the earlier `createdAt`, then the smaller `id` by code-unit order. Input order never matters.
- **Reasons**: `{ code, points, ... }` in score-table order. The codes are `OVERDUE`, `STALE_OVERDUE`, `DUE_TODAY`, `DUE_TOMORROW`, `DUE_IN`, `PRIORITY`, `UNBLOCKS`, `CARRIED_OVER`, `RECURRING` and `ASSUMED_ESTIMATE`, plus `FITS_REMAINING`, which the fit step adds.

### Greedy fit (`suggestPlan`)

- **Effective estimate**: `estimateMin`, or `defaultEstimateMin` (30 by default) when it is null or 0. Those picks carry `ASSUMED_ESTIMATE`.
- **Existing plan**: open tasks in `inPlanIds` are never suggested again, and their effective minutes are subtracted from `availableMin` first. Done tasks don't count. Ids missing from `tasks` count at the default estimate.
- **Fill**: walk the ranking best first and pick each task whose estimate fits in the minutes left. The suggestions never exceed `availableMin − existingMin`. A pick made after a higher-ranked task was skipped for size gets `FITS_REMAINING { remainingMin }` ("Fits your remaining N min", 0 points).
- **Didn't fit**: a skipped task is listed when it is urgent (`OVERDUE` or `DUE_TODAY`) or ranks in the top `FIT_RULES.didntFitTopRanks` (5). Each one has a `size` of `TOO_LARGE { needMin, availableMin }` (bigger than all the time after the existing plan, so suggest splitting it) or `NO_ROOM_LEFT { needMin, remainingMin }`.
- **Nothing fits**: when there are candidates but none fits, `nothingFits.shortest` lists the `FIT_RULES.nothingFitsHints` (3) shortest, shortest first and then by rank, each with a `size`. Otherwise it is `null`.
- **Totals**: `availableMin`, `existingMin`/`existingCount`, `suggestedMin`/`suggestedCount`, `plannedMin`, `remainingMin`, `overMin` (how far the existing plan is already over) and `assumedCount` (planned items using the default estimate, existing plus suggested).
- `availableMin` must be finite and `>= 0`, otherwise the function throws `RangeError`. 1,000 tasks take less than 50 ms.
