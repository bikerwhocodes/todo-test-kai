import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { z } from "zod";
import { localToday } from "@/core/dates";
import { formatDeadline } from "@/core/format";
import { describeEnd, describeRule } from "@/core/recurrence/describe";
import { DeleteSeriesButton } from "@/components/recurring/delete-series-button";
import { SeriesForm } from "@/components/recurring/series-form";
import { listProjects } from "@/server/repo/projects";
import { getSeriesDetail } from "@/server/repo/series";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

type Props = { params: Promise<{ id: string }> };

// Shared by generateMetadata and the page. A non-uuid id would make Postgres throw.
const loadSeries = cache(async (id: string) => {
  const user = await requireUser();
  if (!z.uuid().safeParse(id).success) return null;
  return getSeriesDetail(user.id, id);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const series = await loadSeries((await params).id);
  return { title: `${series?.title ?? "Recurring task"} · NextUp` };
}

export default async function SeriesPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser();
  const series = await loadSeries(id);
  if (!series) notFound();

  const [projects, settings] = await Promise.all([listProjects(user.id), getUserSettings(user.id)]);
  const today = localToday(settings.timeZone, new Date());
  const completedAt = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const end = describeEnd(series.endDate, today);
  const next = series.open?.occurrenceDate;

  return (
    <section>
      <Link href="/recurring" className="mb-2 inline-block text-sm text-stone-500 hover:text-stone-900">
        ← Recurring
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold break-words">{series.title}</h1>
          <p className="mt-1 text-sm text-stone-600">
            {[describeRule(series), next ? end : null, next ? `Next: ${formatDeadline(next, today)}` : "Ended"]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <DeleteSeriesButton id={series.id} title={series.title} />
      </header>

      <p className="mb-3 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700">
        Changes apply to the upcoming occurrence and the ones after it. Past occurrences in the history stay as they
        were.
      </p>
      <SeriesForm
        key={series.id}
        series={{
          id: series.id,
          title: series.title,
          description: series.description,
          priority: series.priority,
          estimateMin: series.estimateMin,
          projectId: series.projectId,
          kind: series.kind,
          interval: series.interval,
          weekdays: series.weekdays,
          startDate: series.startDate,
          endDate: series.endDate,
        }}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        today={today}
      />

      <section aria-labelledby="series-history" className="mt-8">
        <h2 id="series-history" className="mb-2 text-sm font-medium text-stone-700">
          History
        </h2>
        {series.history.length === 0 ? (
          <p className="py-6 text-center text-sm text-stone-500">Nothing completed or skipped yet.</p>
        ) : (
          <ul aria-label="Past occurrences">
            {series.history.map((t) => (
              <li
                key={t.id}
                className="flex items-baseline justify-between gap-3 border-b border-stone-200 py-2 text-sm last:border-b-0"
              >
                <span>{t.occurrenceDate ? formatDeadline(t.occurrenceDate, today) : "—"}</span>
                {t.status === "done" ? (
                  <span className="text-stone-700">
                    Completed
                    {t.completedAt && <span className="text-stone-500"> · {completedAt.format(t.completedAt)}</span>}
                  </span>
                ) : (
                  <span className="text-stone-500">Skipped</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
