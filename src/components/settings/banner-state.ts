import { isTimeZoneMismatch } from "@/core/time-zone";

// Pure logic of the device-mismatch banner, kept apart from the component so it can
// be unit-tested without a DOM.

/** localStorage key holding the profile/browser pair the user last dismissed. */
export const BANNER_DISMISS_KEY = "nextup.timeZoneBanner.dismissed";

/**
 * The stored dismissal value for a pair. Dismissing records the pair rather than a
 * flag, so the banner comes back when either zone changes.
 */
export function dismissalValue(profileZone: string, browserZone: string): string {
  return `${profileZone}|${browserZone}`;
}

/**
 * The browser zone to offer, or null when the banner should stay hidden: the zones
 * match (aliases included), the browser zone is unknown, or this pair was dismissed.
 */
export function bannerZone(profileZone: string, browserZone: unknown, dismissed: string | null): string | null {
  if (!isTimeZoneMismatch(profileZone, browserZone)) return null;
  const zone = browserZone as string;
  return dismissed === dismissalValue(profileZone, zone) ? null : zone;
}
