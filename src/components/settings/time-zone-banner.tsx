"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { updateSettingsAction } from "@/server/actions/settings";
import { quietButtonClass, secondaryButtonClass } from "@/components/ui";
import { BANNER_DISMISS_KEY, bannerZone, dismissalValue } from "./banner-state";

type Device = { zone: string; dismissed: string | null };

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(BANNER_DISMISS_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); just show the banner.
    return null;
  }
}

function writeDismissed(value: string) {
  try {
    window.localStorage.setItem(BANNER_DISMISS_KEY, value);
  } catch {
    // Dismissal then lasts for this page view only.
  }
}

/**
 * Offers the device's zone when it differs from the profile zone. It only ever
 * switches on an explicit click; travelling never moves "today" by itself.
 */
export function TimeZoneBanner({ profileZone }: { profileZone: string }) {
  // Read after mount: the server can't know the device zone, so rendering nothing
  // until then keeps the first client render identical to the server's.
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setDevice({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, dismissed: readDismissed() });
  }, []);

  // Recomputed from the prop, so the banner hides once the layout re-renders with a new zone.
  const zone = device ? bannerZone(profileZone, device.zone, device.dismissed) : null;
  if (!device || !zone) return null;

  function dismiss() {
    const value = dismissalValue(profileZone, zone!);
    writeDismissed(value);
    setDevice({ zone: zone!, dismissed: value });
  }

  function switchToDeviceZone() {
    setError(null);
    startTransition(async () => {
      const result = await updateSettingsAction({ timeZone: zone });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section
      aria-label="Time zone"
      className="mb-4 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700"
    >
      <p>
        Your device is set to <span className="font-medium text-stone-900">{zone}</span>, but NextUp uses{" "}
        <span className="font-medium text-stone-900">{profileZone}</span> for &lsquo;today&rsquo;.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-red-700">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={switchToDeviceZone} disabled={pending} className={secondaryButtonClass}>
          {pending ? "Switching…" : `Use ${zone}`}
        </button>
        <button type="button" onClick={dismiss} disabled={pending} className={quietButtonClass}>
          Keep {profileZone}
        </button>
        <Link href="/settings" className="ml-auto text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline">
          Settings
        </Link>
      </div>
    </section>
  );
}
