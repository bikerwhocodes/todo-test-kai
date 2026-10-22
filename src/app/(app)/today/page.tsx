import type { Metadata } from "next";
import { dueNotInPlan } from "@/core/agenda";
import { localToday } from "@/core/dates";
import { TaskGroup, toGroupItems } from "@/components/tasks/task-group";
import { PlanSection } from "@/components/today/plan-section";
import { listDueTasks } from "@/server/repo/agenda";
import { listProjects } from "@/server/repo/projects";
import { listOpenTaskTitles, type TaskWithSubtasks } from "@/server/repo/tasks";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Today · NextUp" };

export default async function TodayPage() {
  // Layouts don't re-run on client navigation, so each page checks too.
  const user = await requireUser();
  const settings = await getUserSettings(user.id);
  const now = new Date();
  const today = localToday(settings.timeZone, now);
  const [due, projects, taskOptions] = await Promise.all([listDueTasks(user.id, today), listProjects(user.id),
    listOpenTaskTitles(user.id),
  ]);
  // Plan My Day (M5) loads today's plan here. Until then it is empty, so every
  // due task shows below; planned tasks are left out of the due section.
  const planned: TaskWithSubtasks[] = [];
  const unplannedDue = dueNotInPlan(due, today, planned.map((t) => t.id));
  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);

  return (
    <section>
      <h1 className="text-xl font-semibold">Today</h1>
      <p className="mt-1 text-sm break-words text-stone-600">
        {dateLabel} · {settings.timeZone}
      </p>
      <div className="mt-6 space-y-8">
        <PlanSection items={toGroupItems(planned, today)} projects={projectOptions} taskOptions={taskOptions} today={today} />
        <TaskGroup
          heading="Due today & overdue, not in plan"
          items={toGroupItems(unplannedDue, today)}
          projects={projectOptions}
          taskOptions={taskOptions}
          today={today}
          emptyText={due.length > 0 ? "Everything due is in your plan." : "Nothing due today or overdue."}
        />
      </div>
    </section>
  );
}
