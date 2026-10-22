"use client";

import { useId, useState } from "react";
import { formatEstimate } from "@/core/format";
import { inputClass, labelClass } from "@/components/ui";
import { filterSearch, type PlanOption } from "./model";

export const PLAN_SEARCH_ID_ATTR = "data-plan-search";

/**
 * "Add a task": a combobox over the user's open tasks. ↑/↓ move through the
 * matches, Enter picks one, Escape clears the text (a second Escape closes the
 * panel). Tasks already in the list, and blocked ones, aren't offered.
 */
export function PlanSearch({
  options,
  excludeIds,
  onPick,
}: {
  options: PlanOption[];
  excludeIds: Set<string>;
  onPick: (option: PlanOption) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputId = useId();
  const listId = useId();
  const matches = filterSearch(options, query, excludeIds);
  const open = query.trim() !== "";
  const activeIndex = Math.min(active, matches.length - 1);
  const optionId = (i: number) => `${listId}-${i}`;

  function pick(option: PlanOption) {
    onPick(option);
    setQuery("");
    setActive(0);
  }

  return (
    <div>
      <label htmlFor={inputId} className={labelClass}>
        Add a task
      </label>
      <input
        id={inputId}
        {...{ [PLAN_SEARCH_ID_ATTR]: "" }}
        type="text"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (matches.length === 0) return;
            e.preventDefault();
            const delta = e.key === "ArrowDown" ? 1 : -1;
            setActive((activeIndex + delta + matches.length) % matches.length);
          } else if (e.key === "Enter") {
            // Never accepts the plan; picks the highlighted match, if any.
            e.preventDefault();
            const option = matches[activeIndex];
            if (option) pick(option);
          } else if (e.key === "Escape" && query !== "") {
            // Stops the dialog closing: the first Escape only clears the search.
            e.preventDefault();
            setQuery("");
          }
        }}
        placeholder="Search your open tasks"
        autoComplete="off"
        className={`${inputClass} min-h-9 py-1.5 text-sm`}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching open tasks"
        hidden={!open || matches.length === 0}
        className="mt-1 max-h-72 overflow-y-auto rounded-md border border-stone-200 bg-white"
      >
        {matches.map((o, i) => (
          <li
            key={o.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === activeIndex}
            // mousedown would blur the input first; keep focus there so the list stays put.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(o)}
            onMouseMove={() => i !== activeIndex && setActive(i)}
            className={`flex min-h-9 cursor-pointer items-center gap-3 border-b border-stone-100 px-3 py-1.5 text-sm last:border-b-0 ${
              i === activeIndex ? "bg-stone-100" : ""
            }`}
          >
            <span className="min-w-0 flex-1 break-words">{o.title}</span>
            {o.estimateMin !== null && (
              <span className="shrink-0 text-xs text-stone-500">{formatEstimate(o.estimateMin)}</span>
            )}
          </li>
        ))}
      </ul>
      {open && matches.length === 0 && <p className="mt-1 text-sm text-stone-500">No matching open tasks.</p>}
    </div>
  );
}
