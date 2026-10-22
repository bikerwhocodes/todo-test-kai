import "server-only";
import { eq } from "drizzle-orm";
import { localToday, type IsoDate } from "@/core/dates";
import { normalizeTimeZone } from "@/core/time-zone";
import { db } from "@/server/db";
import { userSettings, type UserSettings } from "@/server/db/schema";
import type { SettingsPatch } from "@/lib/validation";

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

/**
 * Writes the user's zone and/or default estimate. Only the user_settings row
 * changes: deadlines and occurrence dates are floating dates, so they stay as
 * they are and only the Today/Upcoming boundaries move with the new zone.
 */
export async function updateUserSettings(userId: string, patch: SettingsPatch): Promise<UserSettings> {
  // Make sure the row exists first (see getUserSettings), so the update always lands.
  await getUserSettings(userId);
  const values: Partial<typeof userSettings.$inferInsert> = { updatedAt: new Date() };
  if (patch.timeZone !== undefined) values.timeZone = patch.timeZone;
  if (patch.defaultEstimateMin !== undefined) values.defaultEstimateMin = patch.defaultEstimateMin;

  const [row] = await db.update(userSettings).set(values).where(eq(userSettings.userId, userId)).returning();
  if (!row) throw new Error(`user_settings missing for user ${userId}`);
  return row;
}

/** Remembers the available time last entered in Plan My Day. Writes only this user's settings row. */
export async function setLastAvailableMin(userId: string, minutes: number): Promise<void> {
  // As in updateUserSettings: make sure the row exists so the update lands.
  await getUserSettings(userId);
  await db
    .update(userSettings)
    .set({ lastAvailableMin: minutes, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
