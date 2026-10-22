"use client";

import { primaryButtonClass, secondaryButtonClass } from "@/components/ui";
import { OPEN_PLAN_EVENT } from "./events";

/** Marks "Plan my day" buttons; the panel returns focus to one if its opener is gone. */
export const PLAN_TRIGGER_ATTR = "data-plan-trigger";

/**
 * Opens the Plan My Day panel through OPEN_PLAN_EVENT, the same way the "p"
 * shortcut does, so the button can sit in a server-rendered section.
 */
export function PlanMyDayButton({ tone = "secondary" }: { tone?: "primary" | "secondary" }) {
  return (
    <button
      type="button"
      {...{ [PLAN_TRIGGER_ATTR]: "" }}
      aria-haspopup="dialog"
      onClick={() => window.dispatchEvent(new Event(OPEN_PLAN_EVENT))}
      className={`${tone === "primary" ? primaryButtonClass : secondaryButtonClass} min-h-9`}
    >
      Plan my day
    </button>
  );
}
