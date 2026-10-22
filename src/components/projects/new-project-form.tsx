"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { PROJECT_NAME_MAX } from "@/lib/limits";
import { createProjectAction } from "@/server/actions/projects";
import { inputClass, quietButtonClass } from "@/components/ui";

export function NewProjectForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputId = useId();

  function close() {
    setOpen(false);
    setName("");
    setError(null);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createProjectAction({ name });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      router.push(`/projects/${result.data.id}`);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      >
        + New project
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-1">
      <label htmlFor={inputId} className="sr-only">
        Project name
      </label>
      <input
        id={inputId}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
        placeholder="Project name"
        maxLength={PROJECT_NAME_MAX}
        autoFocus
        autoComplete="off"
        enterKeyHint="done"
        readOnly={pending}
        className={`${inputClass} py-1.5 text-sm`}
      />
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-1">
        <button type="submit" disabled={pending} className={quietButtonClass}>
          {pending ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={close} className={quietButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}
