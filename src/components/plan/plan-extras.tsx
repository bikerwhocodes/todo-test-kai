"use client";

import { useEffect, useId, useRef, useState } from "react";
import { explainReasons, explainSize } from "@/core/scheduler/explain";
import type { BlockedTask, PlanDraft } from "@/server/repo/plans";
import { inputClass, quietButtonClass, secondaryButtonClass } from "@/components/ui";
import { defaultSplitMin, formatNothingFits, nothingToPlanReasons, readDuration, reasonChips } from "./model";

export type DidntFitItem = PlanDraft["didntFit"][number];

const summaryClass =
  "flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1 text-sm font-medium text-stone-700 select-none hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-stone-500 outline-none";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-2.5 py-1 text-xs`;

/** "Didn't fit (n)": tasks left out for size, each with why, "Add anyway" and "Split". */
export function DidntFitSection({
  items,
  remainingMin,
  onAddAnyway,
  onSplit,
}: {
  items: DidntFitItem[];
  remainingMin: number;
  onAddAnyway: (item: DidntFitItem) => void;
  /** Resolves to an error message, or null once the first part is in the draft. */
  onSplit: (item: DidntFitItem, minutes: number) => Promise<string | null>;
}) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-md border border-stone-200 bg-white px-2 py-1">
      <summary className={summaryClass}>Didn&apos;t fit ({items.length})</summary>
      <ul className="mt-1 divide-y divide-stone-100">
        {items.map((d) => (
          <DidntFitRow
            key={d.task.id}
            item={d}
            remainingMin={remainingMin}
            onAddAnyway={() => onAddAnyway(d)}
            onSplit={(min) => onSplit(d, min)}
          />
        ))}
      </ul>
    </details>
  );
}

function DidntFitRow({
  item,
  remainingMin,
  onAddAnyway,
  onSplit,
}: {
  item: DidntFitItem;
  remainingMin: number;
  onAddAnyway: () => void;
  onSplit: (minutes: number) => Promise<string | null>;
}) {
  const [splitting, setSplitting] = useState(false);
  return (
    <li className="py-2">
      <p className="text-sm break-words text-stone-900">{item.title}</p>
      <p className="mt-0.5 text-xs text-stone-600">{explainSize(item.size)}</p>
      <ReasonChips labels={explainReasons(item.reasons)} />
      {splitting ? (
        <SplitForm
          title={item.title}
          defaultMin={defaultSplitMin(remainingMin)}
          onCancel={() => setSplitting(false)}
          onSplit={async (min) => {
            const error = await onSplit(min);
            if (!error) setSplitting(false);
            return error;
          }}
        />
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={onAddAnyway} className={smallButtonClass}>
            Add anyway
          </button>
          <button type="button" onClick={() => setSplitting(true)} className={smallButtonClass}>
            Split
          </button>
        </div>
      )}
    </li>
  );
}

/** "Plan a first part of: [__] min": makes "<title> (part 1)" and adds it to the draft. */
function SplitForm({
  title,
  defaultMin,
  onCancel,
  onSplit,
}: {
  title: string;
  defaultMin: number;
  onCancel: () => void;
  onSplit: (minutes: number) => Promise<string | null>;
}) {
  const [text, setText] = useState(String(defaultMin));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => inputRef.current?.select(), []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = readDuration(text);
    if (!result.ok) return setError(result.error);
    setPending(true);
    const failed = await onSplit(result.minutes!);
    setPending(false);
    if (failed) setError(failed);
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label={`Split ${title}`} className="mt-2">
      <label htmlFor={inputId} className="block text-xs text-stone-700">
        Plan a first part of:
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5">
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            readOnly={pending}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Closes the form, not the dialog.
                e.preventDefault();
                onCancel();
              }
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={`${inputClass} min-h-9 w-20 py-1 text-sm`}
          />
          <span className="text-sm text-stone-600">min</span>
        </span>
        <button type="submit" disabled={pending} className={smallButtonClass}>
          {pending ? "Adding…" : "Add part 1"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className={`${quietButtonClass} min-h-9 text-xs`}>
          Cancel
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs text-stone-500">Adds a new task; the original stays as it is.</p>
    </form>
  );
}

/** "Blocked (n)": tasks waiting on open tasks. Read-only. */
export function BlockedSection({ items }: { items: BlockedTask[] }) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-md border border-stone-200 bg-white px-2 py-1">
      <summary className={summaryClass}>Blocked ({items.length})</summary>
      <ul className="mt-1 divide-y divide-stone-100">
        {items.map((b) => (
          <li key={b.id} className="py-2">
            <p className="text-sm break-words text-stone-900">{b.title}</p>
            <p className="mt-0.5 text-xs break-words text-amber-800">
              {b.waitingOn.length > 0 ? `Waiting on ${b.waitingOn.join(", ")}` : "Waiting on another task"}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** No candidate fits the time: say what the shortest ones need, with "Add anyway" and "more time". */
export function NothingFits({
  availableMin,
  shortest,
  onAddAnyway,
  onMoreTime,
}: {
  availableMin: number;
  /** The draft's shortest candidates, leaving out any already added. */
  shortest: DidntFitItem[];
  onAddAnyway: (item: DidntFitItem) => void;
  onMoreTime: () => void;
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-3">
      <p className="text-sm text-stone-800">
        {formatNothingFits(
          availableMin,
          shortest.map((d) => d.estimateMin),
        )}
      </p>
      {shortest.length > 0 && (
        <ul className="mt-2 divide-y divide-stone-100">
          {shortest.map((d) => (
            <li key={d.task.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 text-sm break-words">{d.title}</span>
              <button type="button" onClick={() => onAddAnyway(d)} className={smallButtonClass}>
                Add anyway
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onMoreTime} className={`${secondaryButtonClass} mt-3 min-h-9`}>
        Pick more time
      </button>
    </div>
  );
}

/** No suggestions, nothing that didn't fit, nothing planned: say why, from the draft's counts. */
export function NothingToPlan({ draft }: { draft: PlanDraft }) {
  const reasons = nothingToPlanReasons(draft.excluded, draft.blocked.length);
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4 text-center">
      <p className="text-sm font-medium text-stone-800">Nothing to plan right now</p>
      <ul className="mt-1 text-sm text-stone-500">
        {reasons.map((r) => (
          <li key={r}>{r}.</li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-stone-500">You can still add a task below.</p>
    </div>
  );
}

function ReasonChips({ labels }: { labels: string[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {reasonChips(labels).map((l, i) => (
        <span key={i} className="inline-flex max-w-full rounded bg-amber-50 px-1.5 py-0.5 text-xs break-words text-amber-900">
          {l}
        </span>
      ))}
    </div>
  );
}
