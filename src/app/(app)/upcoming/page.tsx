import type { Metadata } from "next";
import { localToday } from "@/core/dates";
import { formatDeadline } from "@/core/format";
import { UPCOMING_DAYS } from "@/core/views";
import { TaskList } from "@/components/tasks/task-list";
import { toTaskView } from "@/components/tasks/types";
import { listProjects } from "@/server/repo/projects";
import { occurrenceBadges } from "@/server/repo/series";
import { listUpcoming, type TaskWithSubtasks } from "@/server/repo/tasks";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Upcoming · NextUp" };

/** Groups by the floating date the task is listed under, earliest day first. */
function groupByDate(tasks: TaskWithSubtasks[]): [string, TaskWithSubtasks[]][] {
  const groups = new Map<string, TaskWithSubtasks[]>();
  for (const task of tasks) {
    // Occurrences are dated by occurrence_date, one-off tasks by deadline.
    const date = task.occurrenceDate ?? task.deadline;
    if (!date) continue;
    groups.set(date, [...(groups.get(date) ?? []), task]);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export default async function UpcomingPage() {
  const user = await requireUser();
  const [settings, projects] = await Promise.all([getUserSettings(user.id), listProjects(user.id)]);
  const today = localToday(settings.timeZone, new Date());

  const upcoming = await listUpcoming(user.id, today);
  const badges = await occurrenceBadges(user.id, upcoming, today);
  const days = groupByDate(upcoming);
  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <section>
      <h1 className="text-xl font-semibold">Upcoming</h1>
      <p className="mt-1 text-sm text-stone-600">
        The next {UPCOMING_DAYS} days · {settings.timeZone}
      </p>

      {days.length === 0 ? (
        <p className="py-6 text-center text-sm text-stone-500">Nothing scheduled for the next {UPCOMING_DAYS} days.</p>
      ) : (
        days.map(([date, tasks]) => {
          const headingId = `day-${date}`;
          const label = formatDeadline(date, today);
          return (
            <section key={date} aria-labelledby={headingId} className="mt-8">
              <h2 id={headingId} className="mb-2 text-sm font-medium text-stone-700">
                {label}
              </h2>
              <TaskList
                open={tasks.map((t) => toTaskView(t, badges.get(t.id)))}
                done={[]}
                projects={projectOptions}
                today={today}
                label={label}
                emptyText=""
              />
            </section>
          );
        })
      )}
    </section>
  );
}
