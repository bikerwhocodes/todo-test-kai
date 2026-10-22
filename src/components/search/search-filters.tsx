"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { normalizeSearchText, searchHref, type SearchQuery } from "@/core/search";
import { inputClass, secondaryButtonClass } from "@/components/ui";

const TEXT_DEBOUNCE_MS = 250;

export type SearchProjectOption = { id: string; name: string };

const selectClass =
  "rounded-md border bg-white px-2 py-1.5 text-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200";

/**
 * Search box and filters for /search. Every change rewrites the URL (text after a
 * short pause, selects at once) and the server renders the results, so reload and
 * back/forward show the same search. Without JavaScript it is a plain GET form.
 */
export function SearchFilters({ query, projects }: { query: SearchQuery; projects: SearchProjectOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Shows a changed select at once, until the server answers with the new URL's query.
  const [shown, setShown] = useOptimistic(query);
  const [text, setText] = useState(query.q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // q values this component put in the URL that haven't come back as props yet.
  const sent = useRef<string[]>([]);
  const latest = useRef({ shown, text, q: query.q });
  latest.current = { shown, text, q: query.q };

  useEffect(() => () => clearTimeout(timer.current), []);

  // A q we sent coming back must not overwrite what the user has typed since. Any
  // other q (back/forward, "Clear filters", a link) replaces the text.
  useEffect(() => {
    const i = sent.current.indexOf(query.q);
    if (i >= 0) {
      sent.current = sent.current.slice(i + 1);
    } else {
      sent.current = [];
      setText(query.q);
    }
  }, [query.q]);

  function navigate(patch: Partial<SearchQuery>) {
    clearTimeout(timer.current);
    const next = { ...latest.current.shown, q: normalizeSearchText(latest.current.text), ...patch };
    // An unchanged q never comes back as a change, so there is nothing to wait for.
    if (next.q !== latest.current.q) sent.current.push(next.q);
    startTransition(() => {
      setShown(next);
      router.replace(searchHref(next), { scroll: false });
    });
  }

  function onText(value: string) {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (normalizeSearchText(value) !== latest.current.shown.q) navigate({});
    }, TEXT_DEBOUNCE_MS);
  }

  function select<K extends keyof SearchQuery>(
    key: K,
    label: string,
    value: string,
    parse: (v: string) => SearchQuery[K],
    options: [value: string, label: string][],
  ) {
    const active = value !== options[0]![0];
    return (
      <label className="shrink-0">
        <span className="sr-only">{label}</span>
        <select
          name={key}
          value={value}
          onChange={(e) => navigate({ [key]: parse(e.target.value) })}
          className={`${selectClass} ${active ? "border-stone-500 text-stone-900" : "border-stone-300 text-stone-600"}`}
        >
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const nullable = (v: string) => (v === "" ? null : v);
  const flag = (v: string) => (v === "1" ? true : v === "0" ? false : null);
  const flagValue = (v: boolean | null) => (v === null ? "" : v ? "1" : "0");

  return (
    <form
      method="get"
      action="/search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        navigate({});
      }}
      className="mb-4 space-y-2"
      aria-busy={pending || undefined}
    >
      <input
        id="search-input"
        type="search"
        name="q"
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Blur instead of the browser's clear-the-field default.
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        aria-label="Search tasks"
        placeholder="Search titles and notes…"
        autoFocus
        autoComplete="off"
        enterKeyHint="search"
        className={inputClass}
      />
      <div className="flex flex-wrap items-center gap-2">
        {select("project", "Project", shown.project ?? "", nullable, [
          ["", "All projects"],
          ["inbox", "Inbox"],
          ...projects.map((p): [string, string] => [p.id, p.name]),
        ])}
        {select("priority", "Priority", shown.priority === null ? "" : String(shown.priority), (v) => (v === "" ? null : (Number(v) as 1 | 2 | 3 | 4)), [
          ["", "Any priority"],
          ["1", "P1"],
          ["2", "P2"],
          ["3", "P3"],
          ["4", "No priority"],
        ])}
        {select("status", "Status", shown.status, (v) => v as SearchQuery["status"], [
          ["open", "Open"],
          ["done", "Done"],
          ["skipped", "Skipped"],
          ["all", "Any status"],
        ])}
        {select("due", "Deadline", shown.due ?? "", (v) => nullable(v) as SearchQuery["due"], [
          ["", "Any deadline"],
          ["overdue", "Overdue"],
          ["has", "Has deadline"],
          ["none", "No deadline"],
        ])}
        {select("blocked", "Blocked", flagValue(shown.blocked), flag, [
          ["", "Blocked or not"],
          ["1", "Blocked"],
          ["0", "Not blocked"],
        ])}
        {select("estimate", "Estimate", flagValue(shown.estimate), flag, [
          ["", "Any estimate"],
          ["1", "Has estimate"],
          ["0", "No estimate"],
        ])}
        <noscript>
          <button type="submit" className={`${secondaryButtonClass} py-1.5`}>
            Apply
          </button>
        </noscript>
        <span className="text-sm text-stone-500" aria-live="polite">
          {pending ? "Searching…" : ""}
        </span>
      </div>
    </form>
  );
}
