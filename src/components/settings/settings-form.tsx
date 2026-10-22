"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { isTimeZoneMismatch } from "@/core/time-zone";
import { ESTIMATE_MAX_MIN } from "@/lib/limits";
import { updateSettingsAction } from "@/server/actions/settings";
import { inputClass, labelClass, primaryButtonClass, quietButtonClass } from "@/components/ui";

/** Plain settings fields passed from the server page. */
export type SettingsValues = { timeZone: string; defaultEstimateMin: number };

type Draft = { timeZone: string; estimate: string };

type FieldErrors = Record<string, string[] | undefined>;

function draftFrom(settings: SettingsValues): Draft {
  return { timeZone: settings.timeZone, estimate: String(settings.defaultEstimateMin) };
}

/**
 * `zones` comes from the server (timeZoneOptions) so the option list can't differ
 * between the server render and hydration.
 */
export function SettingsForm({ settings, zones }: { settings: SettingsValues; zones: string[] }) {
  const [stored, setStored] = useState(settings);
  const [draft, setDraft] = useState(() => draftFrom(settings));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const [deviceZone, setDeviceZone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = useId();

  useEffect(() => {
    setDeviceZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // Only changed keys are sent; range checks are left to the server's field errors.
  const patch: Record<string, unknown> = {};
  if (draft.timeZone !== stored.timeZone) patch.timeZone = draft.timeZone;
  const estimate = draft.estimate.trim() === "" ? NaN : Number(draft.estimate);
  if (estimate !== stored.defaultEstimateMin) patch.defaultEstimateMin = estimate;
  const dirty = Object.keys(patch).length > 0;

  // The device's name may be an alias the server's list leaves out.
  const options = zones.includes(draft.timeZone) ? zones : [...zones, draft.timeZone].sort();
  const offerDevice = deviceZone !== null && isTimeZoneMismatch(draft.timeZone, deviceZone);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!Number.isFinite(estimate)) {
      setFieldErrors({ defaultEstimateMin: ["Default estimate must be a number of minutes"] });
      return;
    }
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await updateSettingsAction(patch);
      if (!result.ok) {
        // Field errors show next to their inputs; the banner is for everything else.
        if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) setFieldErrors(result.fieldErrors);
        else setError(result.error);
        return;
      }
      const next = { timeZone: result.data.timeZone, defaultEstimateMin: result.data.defaultEstimateMin };
      setStored(next);
      setDraft(draftFrom(next));
      setSaved(true);
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Settings"
      className="space-y-4 rounded-lg border border-stone-200 bg-white p-4 shadow-sm"
    >
      <div>
        <label htmlFor={`${id}-zone`} className={labelClass}>
          Time zone
        </label>
        <select
          id={`${id}-zone`}
          value={draft.timeZone}
          onChange={(e) => set("timeZone", e.target.value)}
          aria-describedby={`${id}-zone-note`}
          className={inputClass}
        >
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        {offerDevice && deviceZone && (
          <button type="button" onClick={() => set("timeZone", deviceZone)} className={`${quietButtonClass} mt-1`}>
            Use this device&rsquo;s zone ({deviceZone})
          </button>
        )}
        <FieldError messages={fieldErrors.timeZone} />
        <p id={`${id}-zone-note`} className="mt-1 text-sm text-stone-500">
          Decides which day counts as &ldquo;today&rdquo;. Changing it never moves deadlines or repeat dates.
        </p>
      </div>

      <div>
        <label htmlFor={`${id}-estimate`} className={labelClass}>
          Default estimate (minutes)
        </label>
        <input
          id={`${id}-estimate`}
          type="number"
          inputMode="numeric"
          min={1}
          max={ESTIMATE_MAX_MIN}
          step={1}
          required
          value={draft.estimate}
          onChange={(e) => set("estimate", e.target.value)}
          className={`${inputClass} w-32`}
        />
        <FieldError messages={fieldErrors.defaultEstimateMin} />
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending || !dirty} className={primaryButtonClass}>
          {pending ? "Saving…" : "Save"}
        </button>
        <span className="text-sm text-stone-500" aria-live="polite">
          {saved && !dirty ? "Saved" : ""}
        </span>
      </div>
    </form>
  );
}

function FieldError({ messages }: { messages: string[] | undefined }) {
  if (!messages?.length) return null;
  return <p className="mt-1 text-sm text-red-700">{messages[0]}</p>;
}
