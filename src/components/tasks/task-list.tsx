import { focusRingClass } from "@/components/ui";
import { TaskRow } from "./task-row";
import type { ProjectOption, TaskOption, TaskView } from "./types";

export function TaskList({
  open,
  done,
  projects,
  taskOptions,
  today,
  emptyText,
}: {
  open: TaskView[];
  done: TaskView[];
  projects: ProjectOption[];
  taskOptions: TaskOption[];
  today: string;
  emptyText: string;
}) {
  return (
    <div>
      {open.length > 0 ? (
        <ul aria-label="Open tasks">
          {open.map((task) => (
            <TaskRow key={task.id} task={task} projects={projects} taskOptions={taskOptions} today={today} />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-stone-500">{emptyText}</p>
      )}

      {done.length > 0 && (
        <details className="mt-6">
          <summary className={`cursor-pointer rounded-md py-1 text-sm font-medium text-stone-600 select-none hover:text-stone-900 ${focusRingClass}`}>
            Completed ({done.length})
          </summary>
          <ul aria-label="Completed tasks" className="mt-2">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} projects={projects} taskOptions={taskOptions} today={today} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
