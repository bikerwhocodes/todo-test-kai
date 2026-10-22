"use client";

import { useState, useTransition } from "react";
import { setProjectArchivedAction } from "@/server/actions/projects";
import { secondaryButtonClass } from "@/components/ui";

export function ArchiveButton({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onClick() {
    setError(null);
    startTransition(async () => {
      const result = await setProjectArchivedAction({ id, archived: !archived });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-label={`${archived ? "Unarchive" : "Archive"} ${name}`}
        className={secondaryButtonClass}
      >
        {archived ? "Unarchive" : "Archive"}
      </button>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
