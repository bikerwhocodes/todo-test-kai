"use client";

import { useId, useState } from "react";
import { formatEstimate } from "@/core/format";
import { inputClass, secondaryButtonClass } from "@/components/ui";
import { PRESET_MINUTES, isPreset, readDuration } from "./model";

/** Marks the control that gets focus when step 1 shows. */
export const TIME_STEP_FOCUS_ATTR = "data-plan-time-focus";

/**
 * Step 1: how much time the user has. A preset, or a custom time typed as
 * "90", "90m", "1h 30m" or "1.5h". `selectedMin` (today's plan's time) is
 * marked; `customDefault` prefills the custom field.
 */
export function TimeStep({
  headingId,
  selectedMin,
  customDefault,
  onChoose,
}: {
  headingId: string;
  selectedMin: number | null;
  customDefault: number | null;
  onChoose: (minutes: number, custom: boolean) => void;
}) {
  const [custom, setCustom] = useState(customDefault === null ? "" : formatEstimate(customDefault));
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const presetSelected = selectedMin !== null && isPreset(selectedMin);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = readDuration(custom);
    if (!result.ok) return setError(result.error);
    onChoose(result.minutes!, true);
  }

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <h3 id={headingId} tabIndex={-1} className="text-base font-medium text-stone-900 outline-none">
        How much time do you have today?
      </h3>
      <div role="group" aria-label="Presets" className="grid grid-cols-3 gap-2">
        {PRESET_MINUTES.map((m, i) => {
          const selected = selectedMin === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={selected}
              {...((selected || (selectedMin === null && i === 0)) && { [TIME_STEP_FOCUS_ATTR]: "" })}
              onClick={() => onChoose(m, false)}
              className={`${secondaryButtonClass} min-h-11 text-base ${
                selected ? "border-stone-900 bg-stone-100 text-stone-900" : ""
              }`}
            >
              {formatEstimate(m)}
            </button>
          );
        })}
      </div>
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-stone-700">
          Custom
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            {...(selectedMin !== null && !presetSelected && { [TIME_STEP_FOCUS_ATTR]: "" })}
            type="text"
            inputMode="text"
            autoComplete="off"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              if (error) setError(null);
            }}
            placeholder="e.g. 90m or 1h 30m"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={`${inputClass} min-h-9 min-w-0 flex-1`}
          />
          <button type="submit" className={`${secondaryButtonClass} min-h-9 shrink-0`}>
            Use
          </button>
        </div>
        {error ? (
          <p id={errorId} className="mt-1 text-sm text-red-700">
            {error}
          </p>
        ) : (
          <p className="mt-1 text-xs text-stone-500">Up to 24h. Minutes or hours, like 90, 1h 30m or 1.5h.</p>
        )}
      </form>
    </section>
  );
}
