"use server";

import type { UserSettings } from "@/server/db/schema";
import type { ActionResult } from "./result";

/** Saves the settings form, or the mismatch banner's explicit "Use <zone>" choice. */
export async function updateSettingsAction(input: unknown): Promise<ActionResult<UserSettings>> {
  throw new Error("not implemented");
}
