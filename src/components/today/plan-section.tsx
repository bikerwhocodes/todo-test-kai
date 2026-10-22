import { TaskGroup, type GroupItem } from "@/components/tasks/task-group";
import type { ProjectOption, TaskOption } from "@/components/tasks/types";

/**
 * Today's plan: the planned tasks in plan order, or the empty state when there is
 * no plan yet.
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
  if (items.length > 0) {
    return <TaskGroup heading="Plan" items={items} projects={projects} taskOptions={taskOptions} today={today} />;
  }
  return (
    <section>
      <h2 className="border-b border-stone-200 pb-1 text-sm font-semibold text-stone-800">Plan</h2>
      <div className="py-6 text-center">
        <p className="text-sm text-stone-700">No plan for today yet.</p>
        <p className="mt-1 text-sm text-stone-500">Plan My Day will suggest tasks that fit your day.</p>
      </div>
    </section>
  );
}
