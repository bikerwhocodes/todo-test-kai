import type { Metadata } from "next";
import { localToday } from "@/core/dates";
import { TaskList } from "@/components/tasks/task-list";
import { toTaskView } from "@/components/tasks/types";
import { listProjects } from "@/server/repo/projects";
import { listDueOccurrences, occurrenceBadges } from "@/server/repo/series";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Today · NextUp" };

export default async function TodayPage() {
  // Layouts don't re-run on client navigation, so each page checks too.
  const user = await requireUser();
  const [settings, projects] = await Promise.all([getUserSettings(user.id), listProjects(user.id)]);
  const now = new Date();
  const today = localToday(settings.timeZone, now);
  const heading = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);

  const due = await listDueOccurrences(user.id, today);
  const badges = await occurrenceBadges(user.id, due, today);

  return (
    <section>
      <h1 className="text-xl font-semibold">Today</h1>
      <p className="mt-1 text-sm text-stone-600">
        {heading} · {settings.timeZone}
      </p>

      <section aria-labelledby="recurring-due" className="mt-8">
        <h2 id="recurring-due" className="mb-2 text-sm font-medium text-stone-700">
          Recurring due
        </h2>
        <TaskList
          open={due.map((t) => toTaskView(t, badges.get(t.id)))}
          done={[]}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          today={today}
          label="Recurring due"
          emptyText="Nothing recurring is due. Enjoy the quiet."
        />
      </section>
    </section>
  );
}
