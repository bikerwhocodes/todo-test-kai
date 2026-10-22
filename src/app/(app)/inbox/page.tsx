import type { Metadata } from "next";
import { localToday } from "@/core/dates";
import { QuickAdd } from "@/components/tasks/quick-add";
import { TaskList } from "@/components/tasks/task-list";
import { toTaskView } from "@/components/tasks/types";
import { listProjects } from "@/server/repo/projects";
import { occurrenceBadges } from "@/server/repo/series";
import { listInboxTasks, listOpenTaskTitles } from "@/server/repo/tasks";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Inbox · NextUp" };

export default async function InboxPage() {
  const user = await requireUser();
  const [tasks, projects, settings, taskOptions] = await Promise.all([
    listInboxTasks(user.id),
    listProjects(user.id),
    getUserSettings(user.id),
    listOpenTaskTitles(user.id),
  ]);
  const today = localToday(settings.timeZone, new Date());
  const badges = await occurrenceBadges(user.id, [...tasks.open, ...tasks.done], today);

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Inbox</h1>
      <QuickAdd projectId={null} placeholder="Add a task to Inbox…" />
      <TaskList
        open={tasks.open.map((t) => toTaskView(t, badges.get(t.id)))}
        done={tasks.done.map((t) => toTaskView(t, badges.get(t.id)))}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        taskOptions={taskOptions}
        today={today}
        emptyText="Inbox is clear. Anything on your mind? Add it above."
      />
    </section>
  );
}
