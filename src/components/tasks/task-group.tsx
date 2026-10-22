import { formatOverdue } from "@/core/agenda";
import type { TaskWithSubtasks } from "@/server/repo/tasks";
import { TaskRow } from "./task-row";
import { toTaskView, type ProjectOption, type TaskView } from "./types";

export type GroupItem = { task: TaskView; overdueBy?: string | null };

/** Rows for TaskGroup; tasks due before `today` say how overdue they are. */
export function toGroupItems(tasks: TaskWithSubtasks[], today: string): GroupItem[] {
  return tasks.map((t) => ({ task: toTaskView(t), overdueBy: t.deadline ? formatOverdue(t.deadline, today) : null }));
}

/** A headed list of open tasks (an Upcoming date, Overdue, Today's sections). Rows behave as in Inbox. */
export function TaskGroup({
  heading,
  items,
  projects,
  today,
  tone = "default",
  emptyText,
}: {
  heading: string;
  items: GroupItem[];
  projects: ProjectOption[];
  today: string;
  tone?: "default" | "overdue";
  /** Shown under the heading when there are no items. */
  emptyText?: string;
}) {
  return (
    <section>
      <h2
        className={`flex flex-wrap items-baseline gap-x-2 border-b border-stone-200 pb-1 text-sm font-semibold break-words ${
          tone === "overdue" ? "text-red-800" : "text-stone-800"
        }`}
      >
        <span className="min-w-0">{heading}</span>
        {items.length > 0 && (
          <span className="text-xs font-normal text-stone-500">
            {items.length} {items.length === 1 ? "task" : "tasks"}
          </span>
        )}
      </h2>
      {items.length > 0 ? (
        <ul aria-label={heading}>
          {items.map(({ task, overdueBy }) => (
            <TaskRow key={task.id} task={task} projects={projects} today={today} overdueBy={overdueBy} />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-stone-500">{emptyText}</p>
      )}
    </section>
  );
}
