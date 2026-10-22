import type { Metadata } from "next";
import Link from "next/link";
import { localToday } from "@/core/dates";
import { formatDeadline } from "@/core/format";
import { describeEnd, describeRule } from "@/core/recurrence/describe";
import { NewSeries } from "@/components/recurring/series-form";
import { listProjects } from "@/server/repo/projects";
import { listSeries } from "@/server/repo/series";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Recurring · NextUp" };

export default async function RecurringPage() {
  const user = await requireUser();
  const [series, projects, settings] = await Promise.all([
    listSeries(user.id),
    listProjects(user.id),
    getUserSettings(user.id),
  ]);
  const today = localToday(settings.timeZone, new Date());
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Recurring</h1>
      <NewSeries
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        today={today}
        defaultOpen={series.length === 0}
      />
      {series.length === 0 ? (
        <p className="py-6 text-center text-sm text-stone-500">
          No recurring tasks yet. Habits and chores you repeat belong here.
        </p>
      ) : (
        <ul aria-label="Recurring tasks">
          {series.map((s) => {
            // Archived projects aren't in listProjects; their name is simply left out.
            const project = s.projectId ? projectNames.get(s.projectId) : undefined;
            // With no open occurrence left the series is over; "Ended" says it all.
            const end = describeEnd(s.endDate, today);
            return (
              <li key={s.id} className="border-b border-stone-200 py-2 last:border-b-0">
                <Link
                  href={`/recurring/${s.id}`}
                  className="block rounded-md outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-stone-300"
                >
                  <span className="block break-words">{s.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                    <span>{describeRule(s)}</span>
                    {s.open ? (
                      <>
                        {end && <span>{end}</span>}
                        <span>Next: {formatDeadline(s.open.occurrenceDate ?? today, today)}</span>
                      </>
                    ) : (
                      <span>Ended</span>
                    )}
                    {project && <span>{project}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
