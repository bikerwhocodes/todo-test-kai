"use client";

import { useId, useState, useTransition } from "react";
import { addBlockerAction, removeBlockerAction } from "@/server/actions/tasks";
import { inputClass } from "@/components/ui";
import type { BlockerView, TaskOption } from "./types";

const MAX_RESULTS = 8;

/**
 * "Blocked by" section of the task editor: the task's current blockers, each
 * removable, and a search over the user's other open tasks to add one. The
 * server refuses links that would close a loop; its message is shown here and
 * nothing is saved.
 */
export function BlockerPicker({
  taskId,
  blockers,
  options,
}: {
  taskId: string;
  blockers: BlockerView[];
  options: TaskOption[];
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const headingId = useId();
  const inputId = useId();
  const resultsId = useId();

  const taken = new Set([taskId, ...blockers.map((b) => b.id)]);
  const needle = query.trim().toLocaleLowerCase();
  const matches =
    needle === ""
      ? []
      : options.filter((o) => !taken.has(o.id) && o.title.toLocaleLowerCase().includes(needle)).slice(0, MAX_RESULTS);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, onSuccess?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) onSuccess?.();
      else setError(result.error);
    });
  }

  function onAdd(option: TaskOption) {
    run(
      () => addBlockerAction({ taskId, blockedByTaskId: option.id }),
      () => setQuery(""),
    );
  }

  function onRemove(blocker: BlockerView) {
    run(() => removeBlockerAction({ taskId, blockedByTaskId: blocker.id }));
  }

  return (
    <section aria-labelledby={headingId} aria-busy={pending || undefined}>
      <h3 id={headingId} className="mb-2 text-sm font-medium text-stone-700">
        Blocked by
      </h3>
      {blockers.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {blockers.map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-sm">
              <span className={`min-w-0 flex-1 break-words ${b.open ? "" : "text-stone-500 line-through"}`}>
                {b.title}
                {!b.open && <span className="sr-only"> (completed, no longer blocking)</span>}
              </span>
              <button
                type="button"
                onClick={() => onRemove(b)}
                disabled={pending}
                aria-label={`Remove blocker: ${b.title}`}
                className="rounded px-2 py-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 disabled:opacity-60"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 text-sm text-stone-500">Not waiting on anything.</p>
      )}

      <label htmlFor={inputId} className="sr-only">
        Find a task this one waits on
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Enter picks the only match instead of submitting anything.
            e.preventDefault();
            if (matches.length === 1) onAdd(matches[0]!);
          } else if (e.key === "Escape" && query !== "") {
            // First Escape clears the search; the next one closes the editor.
            e.stopPropagation();
            setQuery("");
          }
        }}
        placeholder="Waits on… (search open tasks)"
        autoComplete="off"
        aria-controls={needle !== "" ? resultsId : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className={`${inputClass} py-1.5 text-sm`}
      />
      {needle !== "" && (
        <div id={resultsId}>
          {matches.length > 0 ? (
            <ul aria-label="Matching open tasks" className="mt-1 rounded-md border border-stone-200">
              {matches.map((o) => (
                <li key={o.id} className="border-b border-stone-100 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onAdd(o)}
                    disabled={pending}
                    aria-label={`Add blocker: ${o.title}`}
                    className="block w-full px-3 py-1.5 text-left text-sm break-words hover:bg-stone-100 disabled:opacity-60"
                  >
                    {o.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-stone-500">No matching open tasks.</p>
          )}
        </div>
      )}
      {error && (
        <p id={`${inputId}-error`} role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
