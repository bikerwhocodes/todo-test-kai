"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { DESCRIPTION_MAX, ESTIMATE_MAX_MIN, NO_PRIORITY, TITLE_MAX } from "@/lib/limits";
import { deleteTaskAction, updateTaskAction } from "@/server/actions/tasks";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui";
import { BlockerPicker } from "./blocker-picker";
import { SubtaskChecklist } from "./subtask-checklist";
import type { ProjectOption, TaskOption, TaskView } from "./types";

type Draft = {
  title: string;
  description: string;
  priority: string;
  deadline: string;
  estimate: string;
  projectId: string;
};

type FieldErrors = Record<string, string[] | undefined>;

function draftFrom(task: TaskView): Draft {
  return {
    title: task.title,
    description: task.description ?? "",
    priority: String(task.priority),
    deadline: task.deadline ?? "",
    estimate: task.estimateMin === null ? "" : String(task.estimateMin),
    projectId: task.projectId ?? "",
  };
}

/**
 * Only changed fields go into the patch, and empty inputs become null (clear).
 * Leaving projectId out unless it changed also lets tasks in an archived
 * project be edited: the server only checks the project when it's sent.
 */
function buildPatch(task: TaskView, draft: Draft): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {};
  if (draft.title !== task.title) patch.title = draft.title;

  const description = draft.description.trim() === "" ? null : draft.description;
  if (description !== task.description) patch.description = description;

  const priority = Number(draft.priority);
  if (priority !== task.priority) patch.priority = priority === NO_PRIORITY ? null : priority;

  const deadline = draft.deadline === "" ? null : draft.deadline;
  if (deadline !== task.deadline) patch.deadline = deadline;

  let estimate: number | null = null;
  if (draft.estimate.trim() !== "") {
    estimate = Number(draft.estimate);
    if (!Number.isFinite(estimate)) return { error: "Estimate must be a number of minutes" };
  }
  if (estimate !== task.estimateMin) patch.estimateMin = estimate;

  const projectId = draft.projectId === "" ? null : draft.projectId;
  if (projectId !== task.projectId) patch.projectId = projectId;

  return { patch };
}

export function TaskEditor({
  task,
  projects,
  taskOptions,
  onClose,
}: {
  task: TaskView;
  projects: ProjectOption[];
  /** The user's open tasks, for the "Blocked by" picker. */
  taskOptions: TaskOption[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(task));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();
  const id = useId();

  const built = buildPatch(task, draft);
  const dirty = "error" in built || Object.keys(built.patch).length > 0;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ("error" in built) {
      setError(built.error);
      return;
    }
    if (Object.keys(built.patch).length === 0) {
      onClose();
      return;
    }
    const patch = built.patch;
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await updateTaskAction({ id: task.id, ...patch });
      if (!result.ok) {
        // Field errors show next to their inputs; the banner is for everything else.
        if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) setFieldErrors(result.fieldErrors);
        else setError(result.error);
        return;
      }
      onClose();
    });
  }

  function onDelete() {
    if (!window.confirm(`Delete "${task.title}"? This also deletes its subtasks and its "blocked by" links.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteTaskAction({ id: task.id });
      if (!result.ok) setError(result.error);
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  // The current project may be archived (and so missing from the picker).
  const projectOptions =
    task.projectId && !projects.some((p) => p.id === task.projectId)
      ? [...projects, { id: task.projectId, name: "Current project (archived)" }]
      : projects;

  return (
    <div onKeyDown={onKeyDown} className="space-y-5 rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <form onSubmit={onSubmit} className="space-y-4" aria-label={`Edit "${task.title}"`}>
        <div>
          <label htmlFor={`${id}-title`} className={labelClass}>
            Title
          </label>
          <input
            id={`${id}-title`}
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            maxLength={TITLE_MAX}
            required
            className={inputClass}
          />
          <FieldError messages={fieldErrors.title} />
        </div>

        <div>
          <label htmlFor={`${id}-description`} className={labelClass}>
            Notes
          </label>
          <textarea
            id={`${id}-description`}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
            maxLength={DESCRIPTION_MAX}
            rows={3}
            className={inputClass}
          />
          <FieldError messages={fieldErrors.description} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-priority`} className={labelClass}>
              Priority
            </label>
            <select
              id={`${id}-priority`}
              value={draft.priority}
              onChange={(e) => set("priority", e.target.value)}
              className={inputClass}
            >
              <option value={String(NO_PRIORITY)}>None</option>
              <option value="1">P1 · Highest</option>
              <option value="2">P2 · High</option>
              <option value="3">P3 · Medium</option>
            </select>
            <FieldError messages={fieldErrors.priority} />
          </div>

          <div>
            <label htmlFor={`${id}-project`} className={labelClass}>
              Project
            </label>
            <select
              id={`${id}-project`}
              value={draft.projectId}
              onChange={(e) => set("projectId", e.target.value)}
              className={inputClass}
            >
              <option value="">Inbox</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <FieldError messages={fieldErrors.projectId} />
          </div>

          <div>
            <label htmlFor={`${id}-deadline`} className={labelClass}>
              Deadline
            </label>
            <div className="flex gap-2">
              <input
                id={`${id}-deadline`}
                type="date"
                value={draft.deadline}
                onChange={(e) => set("deadline", e.target.value)}
                className={inputClass}
              />
              <ClearButton
                label="Clear deadline"
                disabled={draft.deadline === ""}
                onClick={() => set("deadline", "")}
              />
            </div>
            <FieldError messages={fieldErrors.deadline} />
          </div>

          <div>
            <label htmlFor={`${id}-estimate`} className={labelClass}>
              Estimate (minutes)
            </label>
            <div className="flex gap-2">
              <input
                id={`${id}-estimate`}
                type="number"
                inputMode="numeric"
                min={1}
                max={ESTIMATE_MAX_MIN}
                step={1}
                value={draft.estimate}
                onChange={(e) => set("estimate", e.target.value)}
                className={inputClass}
              />
              <ClearButton
                label="Clear estimate"
                disabled={draft.estimate === ""}
                onClick={() => set("estimate", "")}
              />
            </div>
            <FieldError messages={fieldErrors.estimateMin} />
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button type="submit" disabled={pending || !dirty} className={primaryButtonClass}>
            {pending ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            {dirty ? "Cancel" : "Close"}
          </button>
        </div>
      </form>

      <SubtaskChecklist taskId={task.id} subtasks={task.subtasks} />

      <BlockerPicker taskId={task.id} blockers={task.blockers} options={taskOptions} />

      {task.recurrence ? (
        // Occurrences can't be deleted one by one: skip them, or delete the whole series.
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3 text-sm text-stone-500">
          <p>Changes here apply to this occurrence only.</p>
          <Link
            href={`/recurring/${task.recurrence.seriesId}`}
            className="rounded-md px-2 py-1 text-stone-600 hover:bg-stone-100 hover:text-stone-900"
          >
            Edit series
          </Link>
        </div>
      ) : (
        <div className="flex justify-end border-t border-stone-100 pt-3">
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            className="rounded-md px-2 py-1 text-sm text-red-700 hover:bg-red-50 hover:text-red-800 disabled:opacity-60"
          >
            Delete task
          </button>
        </div>
      )}
    </div>
  );
}

function ClearButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} className={secondaryButtonClass}>
      Clear
    </button>
  );
}

function FieldError({ messages }: { messages: string[] | undefined }) {
  if (!messages?.length) return null;
  return (
    <p className="mt-1 text-sm text-red-700">
      {messages[0]}
    </p>
  );
}
