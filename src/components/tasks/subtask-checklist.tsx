"use client";

import { useId, useOptimistic, useState, useTransition } from "react";
import { TITLE_MAX } from "@/lib/limits";
import { addSubtaskAction, deleteSubtaskAction, updateSubtaskAction } from "@/server/actions/tasks";
import { inputClass } from "@/components/ui";
import type { SubtaskView } from "./types";

export function SubtaskChecklist({ taskId, subtasks }: { taskId: string; subtasks: SubtaskView[] }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const headingId = useId();
  const inputId = useId();
  const doneCount = subtasks.filter((s) => s.done).length;

  function onAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = title;
    if (submitted.trim() === "") return;
    setTitle("");
    setError(null);
    startTransition(async () => {
      const result = await addSubtaskAction({ taskId, title: submitted });
      if (!result.ok) {
        setError(result.error);
        setTitle((current) => (current === "" ? submitted : current));
      }
    });
  }

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-2 text-sm font-medium text-stone-700">
        Subtasks
        {subtasks.length > 0 && (
          <span className="ml-2 font-normal text-stone-500">
            {doneCount}/{subtasks.length}
          </span>
        )}
      </h3>
      {subtasks.length > 0 && (
        <ul className="mb-2 space-y-1">
          {subtasks.map((s) => (
            <SubtaskItem key={s.id} subtask={s} onError={setError} />
          ))}
        </ul>
      )}
      <form onSubmit={onAdd}>
        <label htmlFor={inputId} className="sr-only">
          Add subtask
        </label>
        <input
          id={inputId}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add subtask…"
          maxLength={TITLE_MAX}
          autoComplete="off"
          enterKeyHint="done"
          className={`${inputClass} py-1.5 text-sm`}
        />
      </form>
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}

function SubtaskItem({ subtask, onError }: { subtask: SubtaskView; onError: (message: string | null) => void }) {
  const [done, setDone] = useOptimistic(subtask.done);
  const [title, setTitle] = useState(subtask.title);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    onError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) onError(result.error);
    });
  }

  function onToggle() {
    const next = !done;
    run(async () => {
      setDone(next);
      return updateSubtaskAction({ id: subtask.id, done: next });
    });
  }

  function saveTitle() {
    const trimmed = title.trim();
    if (trimmed === subtask.title) return;
    if (trimmed === "") {
      setTitle(subtask.title);
      return;
    }
    run(async () => {
      const result = await updateSubtaskAction({ id: subtask.id, title: trimmed });
      if (!result.ok) setTitle(subtask.title);
      return result;
    });
  }

  function onDelete() {
    run(() => deleteSubtaskAction({ id: subtask.id }));
  }

  return (
    <li className={`flex items-center gap-2 ${pending ? "opacity-70" : ""}`}>
      <input
        type="checkbox"
        checked={done}
        onChange={onToggle}
        aria-label={`Done: ${subtask.title}`}
        className="size-4 shrink-0 accent-stone-800"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape" && title !== subtask.title) {
            // First Escape reverts the edit; the next one closes the editor.
            e.stopPropagation();
            setTitle(subtask.title);
          }
        }}
        aria-label="Subtask title"
        maxLength={TITLE_MAX}
        className={`min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none hover:border-stone-200 focus:border-stone-400 ${done ? "text-stone-500 line-through" : ""}`}
      />
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete subtask: ${subtask.title}`}
        className="rounded px-2 py-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
      >
        ×
      </button>
    </li>
  );
}
