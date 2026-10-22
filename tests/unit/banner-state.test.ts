import { describe, expect, it } from "vitest";
import { bannerZone, dismissalValue } from "@/components/settings/banner-state";

describe("dismissalValue", () => {
  it("differs when either zone differs", () => {
    const base = dismissalValue("Europe/London", "America/Toronto");
    expect(dismissalValue("Europe/Paris", "America/Toronto")).not.toBe(base);
    expect(dismissalValue("Europe/London", "America/Vancouver")).not.toBe(base);
  });
});

describe("bannerZone", () => {
  it("offers the browser zone when it differs and nothing was dismissed", () => {
    expect(bannerZone("Europe/London", "America/Toronto", null)).toBe("America/Toronto");
  });

  it("stays hidden when the zones match, aliases included", () => {
    expect(bannerZone("Europe/London", "Europe/London", null)).toBeNull();
    expect(bannerZone("Asia/Kolkata", "Asia/Calcutta", null)).toBeNull();
  });

  it("stays hidden for a missing or unknown browser zone", () => {
    expect(bannerZone("Europe/London", undefined, null)).toBeNull();
    expect(bannerZone("Europe/London", "Mars/Olympus", null)).toBeNull();
  });

  it("stays hidden once this pair is dismissed", () => {
    const dismissed = dismissalValue("Europe/London", "America/Toronto");
    expect(bannerZone("Europe/London", "America/Toronto", dismissed)).toBeNull();
  });

  it("comes back when the profile zone or the browser zone changes after a dismissal", () => {
    const dismissed = dismissalValue("Europe/London", "America/Toronto");
    expect(bannerZone("Europe/Paris", "America/Toronto", dismissed)).toBe("America/Toronto");
    expect(bannerZone("Europe/London", "America/Vancouver", dismissed)).toBe("America/Vancouver");
  });
});
