"use server";

import { revalidatePath } from "next/cache";
import type { RecurringSeries, Task } from "@/server/db/schema";
import * as seriesRepo from "@/server/repo/series";
import { getUserToday } from "@/server/repo/user-settings";
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
  return runAction(createSeriesInput, input, async (data) => {
    const created = await seriesRepo.createSeries(user.id, data, await getUserToday(user.id));
    refresh();
    return created;
  });
}

/** Updates the template/rule and the open occurrence; closed occurrences are untouched. */
export async function updateSeriesAction(input: unknown): Promise<ActionResult<RecurringSeries>> {
  const user = await requireUser();
  return runAction(updateSeriesInput, input, async ({ id, ...patch }) => {
    const series = await seriesRepo.updateSeries(user.id, id, patch, await getUserToday(user.id));
    refresh();
    return series;
  });
}

/** Deletes the series with all of its occurrences, history included. */
export async function deleteSeriesAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(seriesIdInput, input, async ({ id }) => {
    await seriesRepo.deleteSeries(user.id, id);
    refresh();
  });
}

/** Marks an open occurrence skipped and creates the next one. Idempotent. */
export async function skipOccurrenceAction(
  input: unknown,
): Promise<ActionResult<{ skipped: Task; next: Task | null }>> {
  const user = await requireUser();
  return runAction(taskIdInput, input, async ({ id }) => {
    const result = await seriesRepo.skipOccurrence(user.id, id, await getUserToday(user.id));
    refresh();
    return result;
  });
}
