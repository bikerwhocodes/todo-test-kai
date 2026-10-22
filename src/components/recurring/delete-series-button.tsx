"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteSeriesAction } from "@/server/actions/series";

export function DeleteSeriesButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onClick() {
    if (!window.confirm(`Delete "${title}"? Its open occurrence and its whole history are deleted too.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteSeriesAction({ id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/recurring");
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md px-2 py-1 text-sm text-red-700 hover:bg-red-50 hover:text-red-800 disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Delete series"}
      </button>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
