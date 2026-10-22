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

## Agenda (`core/agenda.ts`)

Upcoming and Today's due section. Callers pass `today = localToday(profileTz, now)`. Deadlines are compared only as `IsoDate`s, and "overdue" means `deadline < today`.

| Function | Notes |
|---|---|
| `groupUpcoming(tasks, today, days = 14)` | Returns `{ overdue, days }`. `overdue` holds open tasks due before today, oldest first. `days` has one group per date from `today` to `today + days - 1` that has tasks. |
| `dueNotInPlan(tasks, today, plannedIds)` | Open tasks due on or before today that are not in the plan, overdue first. |
| `formatDayHeading(date, today)` | "Today · Thu 22 Oct", "Tomorrow · Fri 23 Oct", "Sat 24 Oct". Adds the year when it differs from today's ("Fri 1 Jan 2027"). |
| `formatOverdue(deadline, today)` | "1 day overdue", "3 days overdue", or `null`. |

Tasks that are done or skipped, or that have no deadline, are always left out.

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

## Search (`core/search.ts`)

The `/search` URL contract (see the main README for the params).

| Function | Notes |
|---|---|
| `parseSearchQuery(params): SearchQuery` | Takes Next's `searchParams` (first value of a repeated key). Invalid values become the default; never throws. |
| `searchQueryToParams(query)`, `searchHref(query)` | Canonical: fixed key order, defaults omitted. Round-trips through `parseSearchQuery`. |
| `hasActiveFilters(query)` | Anything other than the default (open tasks, no text). |
| `escapeLike(text)` | Escapes `\`, `%` and `_` for `LIKE`/`ILIKE`. |
| `shouldFocusSearch(event, target)` | Whether a keydown is the `/` shortcut (not in text fields, dialogs, or with Ctrl/Meta/Alt). |
