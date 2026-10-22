"use server";

import { revalidatePath } from "next/cache";
import * as plansRepo from "@/server/repo/plans";
import { getUserToday } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";
import { acceptPlanInput, planTaskInput, reorderPlanInput, suggestPlanInput } from "@/lib/validation";
import { runAction, type ActionResult } from "./result";

// Plan My Day (spec §4). Every action works on the caller's local today; the client
// never sends a date. Each plan edit is saved on its own, right away.

function refresh() {
  revalidatePath("/", "layout");
}

/** Today's draft plan. Saves nothing (so no revalidation): the user reviews it, then accepts. */
export async function suggestPlanAction(input: unknown): Promise<ActionResult<plansRepo.PlanDraft>> {
  const user = await requireUser();
  return runAction(suggestPlanInput, input, async ({ availableMin }) =>
    plansRepo.suggest(user.id, await getUserToday(user.id), availableMin),
  );
}

/** Appends the kept suggestions after today's existing plan. Returns the ids added. */
export async function acceptPlanAction(input: unknown): Promise<ActionResult<string[]>> {
  const user = await requireUser();
  return runAction(acceptPlanInput, input, async ({ taskIds, availableMin, manualTaskIds }) => {
    const added = await plansRepo.acceptSuggestions(user.id, await getUserToday(user.id), {
      taskIds,
      availableMin,
      manualTaskIds,
    });
    refresh();
    return added;
  });
}

export async function addPlanItemAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(planTaskInput, input, async ({ taskId }) => {
    await plansRepo.addPlanItem(user.id, await getUserToday(user.id), taskId);
    refresh();
  });
}

/** Takes the task out of today's plan; the task itself is not changed. */
export async function removePlanItemAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(planTaskInput, input, async ({ taskId }) => {
    await plansRepo.removePlanItem(user.id, await getUserToday(user.id), taskId);
    refresh();
  });
}

export async function reorderPlanAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(reorderPlanInput, input, async ({ taskIds }) => {
    await plansRepo.reorderPlan(user.id, await getUserToday(user.id), taskIds);
    refresh();
  });
}

/** "Not today": hides a suggestion until the user's next local day. */
export async function dismissSuggestionAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(planTaskInput, input, async ({ taskId }) => {
    await plansRepo.dismissSuggestion(user.id, await getUserToday(user.id), taskId);
    refresh();
  });
}
