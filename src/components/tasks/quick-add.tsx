"use client";

import { useRef, useState, useTransition } from "react";
import { createTaskAction } from "@/server/actions/tasks";
import { inputClass } from "@/components/ui";

export const QUICK_ADD_ID = "quick-add";

export function QuickAdd({ projectId, placeholder }: { projectId: string | null; placeholder: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = title;
    if (submitted.trim() === "") {
      setError("Title is required");
      return;
    }
    // Clear right away so several tasks can be typed in a row.
    setTitle("");
    setError(null);
    inputRef.current?.focus();
    startTransition(async () => {
      const result = await createTaskAction({ title: submitted, projectId });
      if (!result.ok) {
        setError(result.fieldErrors?.title?.[0] ?? result.error);
        // Give the text back unless the user has already started the next one.
        setTitle((current) => (current === "" ? submitted : current));
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="mb-6">
      <label htmlFor={QUICK_ADD_ID} className="sr-only">
        New task title
      </label>
      <input
        ref={inputRef}
        id={QUICK_ADD_ID}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          if (error) setError(null);
        }}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="done"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "quick-add-error" : undefined}
        className={inputClass}
      />
      <span className="sr-only" aria-live="polite">
        {pending ? "Adding task…" : ""}
      </span>
      {error && (
        <p id="quick-add-error" role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
