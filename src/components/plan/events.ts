// How the global "p" shortcut reaches the Plan My Day panel on /today.

/** Dispatched on `window` when "p" is pressed on /today; the panel opens on it. */
export const OPEN_PLAN_EVENT = "nextup:open-plan";

/** Other pages send "p" to `/today?plan=1`; the panel opens when it sees this param. */
export const OPEN_PLAN_PARAM = "plan";
