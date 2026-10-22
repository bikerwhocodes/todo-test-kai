// Pure helpers: no I/O, safe to import from client and server code.

export const FALLBACK_TIME_ZONE = "UTC";

/**
 * True when `value` is an IANA zone name this runtime recognises. Raw offsets
 * like "+05:30" are rejected: Postgres reads them with POSIX (inverted) signs.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The client-reported zone as sent (not re-canonicalised: ICU may map current names
 * like "Asia/Kolkata" to old aliases), or UTC when it is missing or unknown.
 */
export function normalizeTimeZone(value: unknown): string {
  return isValidTimeZone(value) ? value : FALLBACK_TIME_ZONE;
}

/**
 * True when the browser's zone differs from the profile zone, so the device-mismatch
 * banner should show. Both names are resolved by this runtime first, so an alias pair
 * like "Asia/Calcutta" / "Asia/Kolkata" is not a mismatch. A missing or unknown
 * browser zone is never a mismatch: we can't offer to switch to it.
 */
export function isTimeZoneMismatch(profileZone: string, browserZone: unknown): boolean {
  throw new Error("not implemented");
}

/**
 * Zone names for the settings picker: the runtime's IANA list, sorted, always
 * including `current` (which may be an alias the list leaves out).
 */
export function timeZoneOptions(current: string): string[] {
  throw new Error("not implemented");
}
