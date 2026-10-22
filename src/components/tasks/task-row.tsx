"use client";

import { useId, useOptimistic, useRef, useState, useTransition } from "react";
import { formatDeadline, formatEstimate, formatPriority } from "@/core/format";
import { setTaskCompletedAction } from "@/server/actions/tasks";
import { TaskEditor } from "./task-editor";
import type { ProjectOption, TaskView } from "./types";

const PRIORITY_CHIP: Record<number, string> = {
  1: "bg-red-50 text-red-800",
  2: "bg-amber-50 text-amber-800",
  3: "bg-sky-50 text-sky-800",
};

export function TaskRow({
  task,
  projects,
  today,
  overdueBy,
}: {
  task: TaskView;
  projects: ProjectOption[];
  today: string;
  /** Shown first in the meta line while the task is open, e.g. "3 days overdue". */
  overdueBy?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [done, setDone] = useOptimistic(task.done);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const editorId = useId();

  function onToggleDone() {
    const next = !done;
    setError(null);
    startTransition(async () => {
      setDone(next);
      const result = await setTaskCompletedAction({ id: task.id, completed: next });
      if (!result.ok) setError(result.error);
    });
  }

  function closeEditor() {
    setExpanded(false);
    toggleRef.current?.focus();
  }

  return (
    <li className="border-b border-stone-200 last:border-b-0">
      <div className="flex items-start gap-3 py-2">
        <input
          type="checkbox"
          checked={done}
          onChange={onToggleDone}
          aria-label={done ? `Reopen "${task.title}"` : `Complete "${task.title}"`}
          className="mt-1.5 size-4 shrink-0 accent-stone-800"
        />
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? editorId : undefined}
          onClick={() => setExpanded((open) => !open)}
          className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-stone-300"
        >
          <span className={`block break-words ${done ? "text-stone-500 line-through" : ""}`}>{task.title}</span>
          <TaskMeta task={task} done={done} today={today} overdueBy={overdueBy} />
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-2 ml-7 text-sm text-red-700">
          {error}
        </p>
      )}
      {expanded && (
        <div id={editorId} className="mb-3 ml-7">
          <TaskEditor task={task} projects={projects} onClose={closeEditor} />
        </div>
      )}
    </li>
  );
}

function TaskMeta({
  task,
  done,
  today,
  overdueBy,
}: {
  task: TaskView;
  done: boolean;
  today: string;
  overdueBy?: string | null;
}) {
  const priority = formatPriority(task.priority);
  const subtasksDone = task.subtasks.filter((s) => s.done).length;
  const overdue = !done && task.deadline !== null && task.deadline < today;
  const chips: React.ReactNode[] = [];

  if (overdueBy && !done) {
    chips.push(
      <span key="o" className="font-medium text-red-700">
        {overdueBy}
      </span>,
    );
  }

  if (priority) {
    chips.push(
      <span key="p" className={`rounded px-1.5 ${PRIORITY_CHIP[task.priority]}`}>
        {priority}
      </span>,
    );
  }
  if (task.deadline) {
    chips.push(
      <span key="d" className={overdue ? "text-red-700" : undefined}>
        <span className="sr-only">{overdue ? "Overdue, due " : "Due "}</span>
        {formatDeadline(task.deadline, today)}
      </span>,
    );
  }
  if (task.estimateMin !== null) {
    chips.push(
      <span key="e">
        <span className="sr-only">Estimate </span>
        {formatEstimate(task.estimateMin)}
      </span>,
    );
  }
  if (task.subtasks.length > 0) {
    chips.push(
      <span key="s">
        <span className="sr-only">Subtasks done </span>
        {subtasksDone}/{task.subtasks.length}
      </span>,
    );
  }
  if (task.description) {
    chips.push(
      <span key="n" title="Has notes">
        <span aria-hidden>¶</span>
        <span className="sr-only">Has notes</span>
      </span>,
    );
  }
  if (chips.length === 0) return null;
  return <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">{chips}</span>;
}
