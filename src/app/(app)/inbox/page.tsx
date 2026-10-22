import type { Metadata } from "next";
import { isoDateInTimeZone } from "@/core/format";
import { QuickAdd } from "@/components/tasks/quick-add";
import { TaskList } from "@/components/tasks/task-list";
import { toTaskView } from "@/components/tasks/types";
import { listProjects } from "@/server/repo/projects";
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

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Inbox</h1>
      <QuickAdd projectId={null} placeholder="Add a task to Inbox…" />
      <TaskList
        open={tasks.open.map(toTaskView)}
        done={tasks.done.map(toTaskView)}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        taskOptions={taskOptions}
        today={isoDateInTimeZone(new Date(), settings.timeZone)}
        emptyText="Inbox is clear. Anything on your mind? Add it above."
      />
    </section>
  );
}
