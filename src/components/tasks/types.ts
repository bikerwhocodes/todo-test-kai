import { blockedSet } from "@/core/graph";
import type { TaskWithSubtasks } from "@/server/repo/tasks";

// Plain shapes passed from server pages to client components.

export type SubtaskView = { id: string; title: string; done: boolean };

/** A direct blocker; `open` blockers are the ones the task is waiting on. */
export type BlockerView = { id: string; title: string; open: boolean };

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
  blockers: BlockerView[];
  /** Derived from the blockers' status, never stored: true iff any blocker is open. */
  blocked: boolean;
};

export type ProjectOption = { id: string; name: string };

/** One of the user's open tasks, offered in the "Blocked by" picker. */
export type TaskOption = { id: string; title: string };

export function toTaskView(task: TaskWithSubtasks): TaskView {
  const blockers = task.blockers.map((b) => ({ id: b.id, title: b.title, open: b.status === "open" }));
  const blocked = blockedSet(
    blockers,
    blockers.map((b) => ({ taskId: task.id, blockedById: b.id })),
  ).has(task.id);
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    deadline: task.deadline,
    estimateMin: task.estimateMin,
    projectId: task.projectId,
    done: task.status === "done",
    subtasks: task.subtasks.map((s) => ({ id: s.id, title: s.title, done: s.done })),
    blockers,
    blocked,
  };
}
