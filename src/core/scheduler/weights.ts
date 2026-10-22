/**
 * Scheduler score table (spec §4.3). Every ranking weight lives here so the
 * rules stay transparent and can be tuned in one place.
 *
 * A candidate's score is the sum of the rows that apply to it:
 *
 * | Rule            | Applies when                                   | Points                                   |
 * |-----------------|------------------------------------------------|------------------------------------------|
 * | OVERDUE         | due 1–14 days ago                              | 100 + 5 × (days late − 1), max 130       |
 * | STALE_OVERDUE   | due more than 14 days ago                      | 40                                       |
 * | DUE_TODAY       | due today                                      | 80                                       |
 * | DUE_TOMORROW    | due tomorrow                                   | 60                                       |
 * | DUE_IN          | due in 2–7 days                                | 50 − 5 × (days − 2)  (50 … 25)           |
 * | PRIORITY        | P1 / P2 / P3 (P4 = none)                       | 40 / 25 / 10                             |
 * | UNBLOCKS        | it directly blocks N open tasks                | 10 × N, capped at 30                     |
 * | CARRIED_OVER    | planned yesterday and not finished             | 5                                        |
 * | RECURRING       | occurrence of a recurring series               | 0 (shown as a reason only)               |
 * | ASSUMED_ESTIMATE| no estimate; the default estimate is used      | 0 (shown as a reason only)               |
 *
 * Invariants the tests pin down:
 * - At equal priority: overdue (any 1–14 days) > due today > due tomorrow > due in N days.
 * - Stale overdue ranks below due today at P1 even with every other bonus:
 *   40 + 40 + 30 + 5 = 115 < 80 + 40 = 120.
 * - Carrying a task over adds only CARRIED_OVER points; it never makes a task urgent.
 */

export const DEADLINE_WEIGHTS = {
  overdueBase: 100,
  overduePerDay: 5,
  overdueMax: 130,
  /** Overdue by more than this many days counts as stale. */
  staleAfterDays: 14,
  staleOverdue: 40,
  dueToday: 80,
  dueTomorrow: 60,
  /** DUE_IN applies for deadlines 2…dueInMaxDays days ahead. */
  dueInMaxDays: 7,
  dueInBase: 50,
  dueInPerDay: 5,
} as const;

/** Points by priority. 1 is the highest; 4 means "no priority". */
export const PRIORITY_WEIGHTS: Readonly<Record<1 | 2 | 3 | 4, number>> = {
  1: 40,
  2: 25,
  3: 10,
  4: 0,
};

export const UNBLOCKS_WEIGHTS = {
  perTask: 10,
  max: 30,
} as const;

export const CARRIED_OVER_POINTS = 5;
export const RECURRING_POINTS = 0;
export const ASSUMED_ESTIMATE_POINTS = 0;
/** FITS_REMAINING is added by the fit step after ranking, so it never changes the order. */
export const FITS_REMAINING_POINTS = 0;

/**
 * Greedy fit (spec §4.4). A task that is too big for the time left is listed
 * under "didn't fit" when it is urgent (overdue 1–14 days or due today) or
 * ranks in the top `didntFitTopRanks`. Other oversized tasks are skipped
 * silently so a long backlog doesn't flood the panel.
 */
export const FIT_RULES = {
  didntFitTopRanks: 5,
  /** How many of the shortest candidates to offer when nothing fits. */
  nothingFitsHints: 3,
} as const;

/** Used when the caller does not pass the user's default estimate. */
export const FALLBACK_DEFAULT_ESTIMATE_MIN = 30;
