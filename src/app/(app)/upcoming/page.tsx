import type { Metadata } from "next";
import { UPCOMING_DAYS, formatDayHeading, formatShortDate, groupUpcoming, upcomingEnd } from "@/core/agenda";
import { localToday } from "@/core/dates";
import { TaskGroup, toGroupItems } from "@/components/tasks/task-group";
import { listUpcomingTasks } from "@/server/repo/agenda";
import { listProjects } from "@/server/repo/projects";
import { occurrenceBadges } from "@/server/repo/series";
import { listOpenTaskTitles } from "@/server/repo/tasks";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Upcoming · NextUp" };

export default async function UpcomingPage() {
  const user = await requireUser();
  const settings = await getUserSettings(user.id);
  // "Today" is the date in the user's profile zone, not the server's.
  const today = localToday(settings.timeZone, new Date());
  const [tasks, projects, taskOptions] = await Promise.all([
    listUpcomingTasks(user.id, today),
    listProjects(user.id),
    listOpenTaskTitles(user.id),
  ]);
  const { overdue, days } = groupUpcoming(tasks, today);
  const badges = await occurrenceBadges(user.id, tasks, today);
  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <section>
      <h1 className="text-xl font-semibold">Upcoming</h1>
      <p className="mt-1 text-sm text-stone-600">
        Next {UPCOMING_DAYS} days · {formatShortDate(today, today)} – {formatShortDate(upcomingEnd(today), today)}
      </p>
      {overdue.length === 0 && days.length === 0 ? (
        <p className="py-6 text-center text-sm text-stone-500">
          Nothing due in the next {UPCOMING_DAYS} days. Tasks with a deadline show up here.
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          {overdue.length > 0 && (
            <TaskGroup
              heading="Overdue"
              tone="overdue"
              items={toGroupItems(overdue, today, badges)}
              projects={projectOptions}
              taskOptions={taskOptions}
              today={today}
            />
          )}
          {days.map((group) => (
            <TaskGroup
              key={group.date}
              heading={formatDayHeading(group.date, today)}
              items={toGroupItems(group.tasks, today, badges)}
              projects={projectOptions}
              taskOptions={taskOptions}
              today={today}
            />
          ))}
        </div>
      )}
    </section>
  );
}
