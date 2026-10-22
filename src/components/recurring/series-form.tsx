"use client";

import { useId, useState, useTransition } from "react";
import { isIsoDate, weekdayOf } from "@/core/dates";
import { WEEKDAY_ORDER, WEEKDAY_SHORT, describeEnd, describeRule } from "@/core/recurrence/describe";
import { DESCRIPTION_MAX, ESTIMATE_MAX_MIN, NO_PRIORITY, TITLE_MAX } from "@/lib/limits";
import { createSeriesAction, updateSeriesAction } from "@/server/actions/series";
import { inputClass, labelClass, primaryButtonClass, quietButtonClass, secondaryButtonClass } from "@/components/ui";
import type { ProjectOption } from "@/components/tasks/types";

/** Plain series fields passed from the server page. */
export type SeriesValues = {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  estimateMin: number | null;
  projectId: string | null;
  kind: "daily" | "weekly";
  interval: number;
  weekdays: number[] | null;
  startDate: string;
  endDate: string | null;
};

type Draft = {
  title: string;
  description: string;
  priority: string;
  estimate: string;
  projectId: string;
  kind: "daily" | "weekly";
  interval: string;
  weekdays: number[];
  startDate: string;
  endDate: string;
};

type FieldErrors = Record<string, string[] | undefined>;

type Rule = {
  kind: "daily" | "weekly";
  interval: number;
  weekdays: number[] | null;
  startDate: string;
  endDate: string | null;
};

function emptyDraft(today: string): Draft {
  return {
    title: "",
    description: "",
    priority: String(NO_PRIORITY),
    estimate: "",
    projectId: "",
    kind: "daily",
    interval: "1",
    weekdays: [],
    startDate: today,
    endDate: "",
  };
}

function draftFrom(series: SeriesValues): Draft {
  return {
    title: series.title,
    description: series.description ?? "",
    priority: String(series.priority),
    estimate: series.estimateMin === null ? "" : String(series.estimateMin),
    projectId: series.projectId ?? "",
    kind: series.kind,
    interval: String(series.interval),
    weekdays: series.weekdays ?? [],
    startDate: series.startDate,
    endDate: series.endDate ?? "",
  };
}

type Values = {
  title: string;
  description: string | null;
  priority: number | null;
  estimateMin: number | null;
  projectId: string | null;
  rule: Rule;
};

/** Parses the draft into action input; range checks are left to the server's field errors. */
function parse(draft: Draft): { values: Values; error?: undefined } | { error: string; values?: undefined } {
  let estimateMin: number | null = null;
  if (draft.estimate.trim() !== "") {
    estimateMin = Number(draft.estimate);
    if (!Number.isFinite(estimateMin)) return { error: "Estimate must be a number of minutes" };
  }
  const interval = Number(draft.interval);
  if (draft.interval.trim() === "" || !Number.isFinite(interval)) {
    return { error: "Repeat interval must be a number" };
  }
  const priority = Number(draft.priority);
  return {
    values: {
      title: draft.title,
      description: draft.description.trim() === "" ? null : draft.description,
      priority: priority === NO_PRIORITY ? null : priority,
      estimateMin,
      projectId: draft.projectId === "" ? null : draft.projectId,
      rule: {
        kind: draft.kind,
        interval,
        weekdays: draft.kind === "weekly" ? [...draft.weekdays].sort((a, b) => a - b) : null,
        startDate: draft.startDate,
        endDate: draft.endDate === "" ? null : draft.endDate,
      },
    },
  };
}

function sameRule(a: Rule, b: Rule): boolean {
  return (
    a.kind === b.kind &&
    a.interval === b.interval &&
    (a.weekdays ?? []).join(",") === (b.weekdays ?? []).join(",") &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate
  );
}

/** Only changed keys go into the update; `rule` is sent whole when any part of it changed. */
function buildPatch(series: SeriesValues, values: Values): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (values.title !== series.title) patch.title = values.title;
  if (values.description !== series.description) patch.description = values.description;
  if ((values.priority ?? NO_PRIORITY) !== series.priority) patch.priority = values.priority;
  if (values.estimateMin !== series.estimateMin) patch.estimateMin = values.estimateMin;
  if (values.projectId !== series.projectId) patch.projectId = values.projectId;
  const current: Rule = {
    kind: series.kind,
    interval: series.interval,
    weekdays: series.kind === "weekly" ? [...(series.weekdays ?? [])].sort((a, b) => a - b) : null,
    startDate: series.startDate,
    endDate: series.endDate,
  };
  if (!sameRule(values.rule, current)) patch.rule = values.rule;
  return patch;
}

/**
 * Create form when `series` is omitted, edit form otherwise. Field errors for the
 * rule come back under one `rule` key (zod flattens nested paths), so they show
 * below the schedule fields.
 */
export function SeriesForm({
  series,
  projects,
  today,
  onDone,
}: {
  series?: SeriesValues;
  projects: ProjectOption[];
  today: string;
  /** Called after a successful create or save (and on Cancel when given). */
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState(() => (series ? draftFrom(series) : emptyDraft(today)));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const id = useId();

  const parsed = parse(draft);
  const patch = series && parsed.values ? buildPatch(series, parsed.values) : null;
  const dirty = !series || parsed.error !== undefined || (patch !== null && Object.keys(patch).length > 0);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setSaved(false);
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // Switching to weekly starts from the start date's weekday rather than nothing.
      if (key === "kind" && value === "weekly" && next.weekdays.length === 0 && isIsoDate(next.startDate)) {
        next.weekdays = [weekdayOf(next.startDate)];
      }
      return next;
    });
  }

  function toggleWeekday(day: number) {
    set(
      "weekdays",
      draft.weekdays.includes(day) ? draft.weekdays.filter((d) => d !== day) : [...draft.weekdays, day],
    );
  }

  function showErrors(result: { error: string; fieldErrors?: FieldErrors }) {
    // Field errors show next to their inputs; the banner is for everything else.
    if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) setFieldErrors(result.fieldErrors);
    else setError(result.error);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parsed.error !== undefined) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setFieldErrors({});
    const values = parsed.values;
    startTransition(async () => {
      if (series) {
        const result = await updateSeriesAction({ id: series.id, ...patch });
        if (!result.ok) return showErrors(result);
        // Start from what was stored (trimmed title, sorted weekdays) so the form reads as saved.
        setDraft(draftFrom(result.data));
        setSaved(true);
      } else {
        const result = await createSeriesAction(values);
        if (!result.ok) return showErrors(result);
        setDraft(emptyDraft(today));
      }
      onDone?.();
    });
  }

  // The series' project may be archived (and so missing from the picker).
  const projectOptions =
    series?.projectId && !projects.some((p) => p.id === series.projectId)
      ? [...projects, { id: series.projectId, name: "Current project (archived)" }]
      : projects;

  const intervalNumber = Number(draft.interval);
  const summary = [
    describeRule({ kind: draft.kind, interval: intervalNumber, weekdays: draft.weekdays }),
    isIsoDate(draft.endDate) ? describeEnd(draft.endDate, today) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <form
      onSubmit={onSubmit}
      aria-label={series ? `Edit "${series.title}"` : "New recurring task"}
      className="space-y-4 rounded-lg border border-stone-200 bg-white p-4 shadow-sm"
    >
      <div>
        <label htmlFor={`${id}-title`} className={labelClass}>
          Title
        </label>
        <input
          id={`${id}-title`}
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          maxLength={TITLE_MAX}
          required
          autoComplete="off"
          placeholder={series ? undefined : "e.g. Water the plants"}
          className={inputClass}
        />
        <FieldError messages={fieldErrors.title} />
      </div>

      {series && (
        <div>
          <label htmlFor={`${id}-description`} className={labelClass}>
            Notes
          </label>
          <textarea
            id={`${id}-description`}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={DESCRIPTION_MAX}
            rows={3}
            className={inputClass}
          />
          <FieldError messages={fieldErrors.description} />
        </div>
      )}

      <fieldset className="space-y-4">
        <legend className="sr-only">Schedule</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-kind`} className={labelClass}>
              Repeats
            </label>
            <select
              id={`${id}-kind`}
              value={draft.kind}
              onChange={(e) => set("kind", e.target.value as Draft["kind"])}
              className={inputClass}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>

          <div>
            <label htmlFor={`${id}-interval`} className={labelClass}>
              Every
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`${id}-interval`}
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                step={1}
                required
                value={draft.interval}
                onChange={(e) => set("interval", e.target.value)}
                aria-describedby={`${id}-interval-unit`}
                className={`${inputClass} w-24`}
              />
              <span id={`${id}-interval-unit`} className="text-sm text-stone-600">
                {draft.kind === "daily"
                  ? intervalNumber === 1
                    ? "day"
                    : "days"
                  : intervalNumber === 1
                    ? "week"
                    : "weeks"}
              </span>
            </div>
          </div>
        </div>

        {draft.kind === "weekly" && (
          <div role="group" aria-labelledby={`${id}-weekdays`}>
            <span id={`${id}-weekdays`} className={labelClass}>
              On
            </span>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_ORDER.map((day) => {
                const on = draft.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleWeekday(day)}
                    className={`w-12 rounded-md border px-2 py-1.5 text-sm ${
                      on
                        ? "border-stone-800 bg-stone-800 text-white hover:bg-stone-700"
                        : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
                    }`}
                  >
                    {WEEKDAY_SHORT[day]}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-start`} className={labelClass}>
              Starts
            </label>
            <input
              id={`${id}-start`}
              type="date"
              required
              value={draft.startDate}
              onChange={(e) => set("startDate", e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor={`${id}-end`} className={labelClass}>
              Ends <span className="font-normal text-stone-500">(optional)</span>
            </label>
            <div className="flex gap-2">
              <input
                id={`${id}-end`}
                type="date"
                min={draft.startDate || undefined}
                value={draft.endDate}
                onChange={(e) => set("endDate", e.target.value)}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => set("endDate", "")}
                disabled={draft.endDate === ""}
                aria-label="Clear end date"
                className={secondaryButtonClass}
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        <p className="text-sm text-stone-600" aria-live="polite">
          {summary}
        </p>
        <FieldError messages={fieldErrors.rule} />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-project`} className={labelClass}>
            Project
          </label>
          <select
            id={`${id}-project`}
            value={draft.projectId}
            onChange={(e) => set("projectId", e.target.value)}
            className={inputClass}
          >
            <option value="">Inbox</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <FieldError messages={fieldErrors.projectId} />
        </div>

        <div>
          <label htmlFor={`${id}-priority`} className={labelClass}>
            Priority
          </label>
          <select
            id={`${id}-priority`}
            value={draft.priority}
            onChange={(e) => set("priority", e.target.value)}
            className={inputClass}
          >
            <option value={String(NO_PRIORITY)}>None</option>
            <option value="1">P1 · Highest</option>
            <option value="2">P2 · High</option>
            <option value="3">P3 · Medium</option>
          </select>
          <FieldError messages={fieldErrors.priority} />
        </div>

        <div>
          <label htmlFor={`${id}-estimate`} className={labelClass}>
            Estimate (minutes)
          </label>
          <input
            id={`${id}-estimate`}
            type="number"
            inputMode="numeric"
            min={1}
            max={ESTIMATE_MAX_MIN}
            step={1}
            value={draft.estimate}
            onChange={(e) => set("estimate", e.target.value)}
            className={inputClass}
          />
          <FieldError messages={fieldErrors.estimateMin} />
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending || !dirty} className={primaryButtonClass}>
          {series ? (pending ? "Saving…" : "Save") : pending ? "Creating…" : "Create"}
        </button>
        {!series && onDone && (
          <button type="button" onClick={onDone} className={quietButtonClass}>
            Cancel
          </button>
        )}
        <span className="text-sm text-stone-500" aria-live="polite">
          {saved && !dirty ? "Saved" : ""}
        </span>
      </div>
    </form>
  );
}

/** "+ New recurring task" that opens the create form; starts open when there are no series yet. */
export function NewSeries({
  projects,
  today,
  defaultOpen,
}: {
  projects: ProjectOption[];
  today: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-6 rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      >
        + New recurring task
      </button>
    );
  }

  return (
    <div className="mb-6">
      <SeriesForm projects={projects} today={today} onDone={() => setOpen(false)} />
    </div>
  );
}

function FieldError({ messages }: { messages: string[] | undefined }) {
  if (!messages?.length) return null;
  return <p className="mt-1 text-sm text-red-700">{messages[0]}</p>;
}
