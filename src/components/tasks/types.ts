import type { TaskWithSubtasks } from "@/server/repo/tasks";

// Plain shapes passed from server pages to client components.

export type SubtaskView = { id: string; title: string; done: boolean };

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
};

export type ProjectOption = { id: string; name: string };

export function toTaskView(task: TaskWithSubtasks): TaskView {
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
  };
}
