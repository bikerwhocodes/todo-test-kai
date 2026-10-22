"use server";

import { revalidatePath } from "next/cache";
import type { RecurringSeries, Task } from "@/server/db/schema";
import { requireUser } from "@/server/session";
import { createSeriesInput, seriesIdInput, taskIdInput, updateSeriesInput } from "@/lib/validation";
import { runAction, type ActionResult } from "./result";

// Completing and reopening occurrences go through setTaskCompletedAction in ./tasks;
// the repo routes series rows to the recurrence rules.

function refresh() {
  revalidatePath("/", "layout");
}

/** Creates the series and its first open occurrence (null if the rule has no date left). */
export async function createSeriesAction(
  input: unknown,
): Promise<ActionResult<{ series: RecurringSeries; occurrence: Task | null }>> {
  const user = await requireUser();
  return runAction(createSeriesInput, input, async () => {
    void user;
    refresh();
    throw new Error("TODO(M3): createSeriesAction");
  });
}

/** Updates the template/rule and the open occurrence; closed occurrences are untouched. */
export async function updateSeriesAction(input: unknown): Promise<ActionResult<RecurringSeries>> {
  const user = await requireUser();
  return runAction(updateSeriesInput, input, async () => {
    void user;
    refresh();
    throw new Error("TODO(M3): updateSeriesAction");
  });
}

/** Deletes the series with all of its occurrences, history included. */
export async function deleteSeriesAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(seriesIdInput, input, async () => {
    void user;
    refresh();
    throw new Error("TODO(M3): deleteSeriesAction");
  });
}

/** Marks an open occurrence skipped and creates the next one. Idempotent. */
export async function skipOccurrenceAction(
  input: unknown,
): Promise<ActionResult<{ skipped: Task; next: Task | null }>> {
  const user = await requireUser();
  return runAction(taskIdInput, input, async () => {
    void user;
    refresh();
    throw new Error("TODO(M3): skipOccurrenceAction");
  });
}
