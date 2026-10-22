import type { GroupItem } from "@/components/tasks/task-group";
import { TaskRow } from "@/components/tasks/task-row";
import type { ProjectOption, TaskOption } from "@/components/tasks/types";
import { PlanMyDayButton } from "@/components/plan/plan-button";

/**
 * Today's plan: the planned tasks in plan order, or the empty state when there is
 * no plan yet. The header, and the empty state too, have a "Plan my day" button
 * that opens the panel (PlanPanel, rendered alongside on the page).
 */
export function PlanSection({
  items,
  projects,
  taskOptions,
  today,
}: {
  items: GroupItem[];
  projects: ProjectOption[];
  taskOptions: TaskOption[];
  today: string;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b border-stone-200 pb-1">
        <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-semibold break-words text-stone-800">
          <span className="min-w-0">Plan</span>
          {items.length > 0 && (
            <span className="text-xs font-normal text-stone-500">
              {items.length} {items.length === 1 ? "task" : "tasks"}
            </span>
          )}
        </h2>
        <PlanMyDayButton />
      </div>
      {items.length > 0 ? (
        <ul aria-label="Plan">
          {items.map(({ task, overdueBy }) => (
            <TaskRow
              key={task.id}
              task={task}
              projects={projects}
              taskOptions={taskOptions}
              today={today}
              overdueBy={overdueBy}
            />
          ))}
        </ul>
      ) : (
        <div className="py-6 text-center">
          <p className="text-sm text-stone-700">No plan for today yet.</p>
          <p className="mt-1 text-sm text-stone-500">Plan My Day will suggest tasks that fit your day.</p>
          <div className="mt-3">
            <PlanMyDayButton tone="primary" />
          </div>
        </div>
      )}
    </section>
  );
}
