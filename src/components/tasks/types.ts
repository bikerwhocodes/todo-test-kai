import type { Subtask, Task } from "@/server/db/schema";
import type { OccurrenceBadge } from "@/server/repo/series";

// Plain shapes passed from server pages to client components.

export type SubtaskView = { id: string; title: string; done: boolean };

/** Set for an occurrence of a recurring series; null for one-off tasks. */
export type RecurrenceView = {
  seriesId: string;
  kind: "daily" | "weekly";
  occurrenceDate: string;
  /** e.g. "Missed 5 days"; null unless the open occurrence is overdue. */
  missedLabel: string | null;
};

export type TaskView = {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  deadline: string | null;
  estimateMin: number | null;
  projectId: string | null;
  done: boolean;
  subtasks: SubtaskView[];
  recurrence: RecurrenceView | null;
};

export type ProjectOption = { id: string; name: string };

/**
 * `badge` comes from occurrenceBadges(); pass it explicitly (not via `.map(toTaskView)`,
 * which would pass the index). Tasks loaded without subtasks show none.
 */
export function toTaskView(task: Task & { subtasks?: Subtask[] }, badge?: OccurrenceBadge | null): TaskView {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    deadline: task.deadline,
    estimateMin: task.estimateMin,
    projectId: task.projectId,
    done: task.status === "done",
    subtasks: (task.subtasks ?? []).map((s) => ({ id: s.id, title: s.title, done: s.done })),
    recurrence: badge
      ? {
          seriesId: badge.seriesId,
          kind: badge.kind,
          occurrenceDate: badge.occurrenceDate,
          missedLabel: badge.missedLabel,
        }
      : null,
  };
}
