"use client";

import { useId, useState, useTransition } from "react";
import { PROJECT_NAME_MAX } from "@/lib/limits";
import { renameProjectAction } from "@/server/actions/projects";
import { inputClass, primaryButtonClass, quietButtonClass } from "@/components/ui";
import { ArchiveButton } from "./archive-button";

export function ProjectHeader({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputId = useId();

  function startEditing() {
    setDraft(name);
    setError(null);
    setEditing(true);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim() === name) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const result = await renameProjectAction({ id, name: draft });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
    });
  }

  if (editing) {
    return (
      <form onSubmit={onSubmit} className="mb-6">
        <label htmlFor={inputId} className="sr-only">
          Project name
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            maxLength={PROJECT_NAME_MAX}
            autoFocus
            autoComplete="off"
            readOnly={pending}
            className={`${inputClass} font-semibold`}
          />
          <button type="submit" disabled={pending} className={primaryButtonClass}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className={quietButtonClass}>
            Cancel
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-sm text-red-700">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <h1 className="min-w-0 text-xl font-semibold break-words">{name}</h1>
      <div className="flex items-start gap-2">
        <button type="button" onClick={startEditing} className={quietButtonClass}>
          Rename
        </button>
        <ArchiveButton id={id} name={name} archived={archived} />
      </div>
    </header>
  );
}
