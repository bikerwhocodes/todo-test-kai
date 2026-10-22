"use server";

import { revalidatePath } from "next/cache";
import type { UserSettings } from "@/server/db/schema";
import * as settingsRepo from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";
import { rememberAvailableTimeInput, updateSettingsInput } from "@/lib/validation";
import { runAction, type ActionResult } from "./result";

function refresh() {
  revalidatePath("/", "layout");
}

/** Saves the settings form, or the mismatch banner's explicit "Use <zone>" choice. */
export async function updateSettingsAction(input: unknown): Promise<ActionResult<UserSettings>> {
  const user = await requireUser();
  return runAction(updateSettingsInput, input, async (patch) => {
    const settings = await settingsRepo.updateUserSettings(user.id, patch);
    refresh();
    return settings;
  });
}

/**
 * Remembers the custom available time the user entered in Plan My Day, so the
 * panel can prefill it next time. Writes only user_settings.last_available_min.
 */
export async function rememberAvailableTimeAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(rememberAvailableTimeInput, input, async ({ availableMin }) => {
    await settingsRepo.setLastAvailableMin(user.id, availableMin);
    refresh();
  });
}
