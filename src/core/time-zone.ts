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
