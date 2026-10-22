import "server-only";
import { eq } from "drizzle-orm";
import { localToday, type IsoDate } from "@/core/dates";
import { normalizeTimeZone } from "@/core/time-zone";
import { db } from "@/server/db";
import { userSettings, type UserSettings } from "@/server/db/schema";

/** Creates the settings row for a new user; a no-op if it already exists. */
export async function createUserSettings(userId: string, timeZone: unknown): Promise<void> {
  await db
    .insert(userSettings)
    .values({ userId, timeZone: normalizeTimeZone(timeZone) })
    .onConflictDoNothing({ target: userSettings.userId });
}

/**
 * Settings for `userId`. If the signup hook never ran (e.g. it failed after the
 * user row was committed) the row is created with defaults rather than erroring.
 */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const existing = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (existing) return existing;
  await createUserSettings(userId, undefined);
  const created = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (!created) throw new Error(`user_settings missing for user ${userId}`);
  return created;
}

/** The user's calendar date right now, in their time zone (spec §7's "today"). */
export async function getUserToday(userId: string, now = new Date()): Promise<IsoDate> {
  const settings = await getUserSettings(userId);
  return localToday(settings.timeZone, now);
}
