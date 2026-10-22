import type { Metadata } from "next";
import Link from "next/link";
import { localToday } from "@/core/dates";
import { SEARCH_LIMIT, hasActiveFilters, parseSearchQuery, type SearchParamsInput } from "@/core/search";
import { SearchFilters } from "@/components/search/search-filters";
import { TaskRow } from "@/components/tasks/task-row";
import { toTaskView } from "@/components/tasks/types";
import { listProjects } from "@/server/repo/projects";
import { searchTasks } from "@/server/repo/search";
import { listOpenTaskTitles } from "@/server/repo/tasks";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Search · NextUp" };

type Props = { searchParams: Promise<SearchParamsInput> };

export default async function SearchPage({ searchParams }: Props) {
  const user = await requireUser();
  const query = parseSearchQuery(await searchParams);
  const [projects, settings, taskOptions] = await Promise.all([
    listProjects(user.id, { includeArchived: true }),
    getUserSettings(user.id),
    listOpenTaskTitles(user.id),
  ]);
  const today = localToday(settings.timeZone, new Date());
  // Another user's (or a made-up) project id matches nothing; searchTasks is user-scoped anyway.
  const knownProject = query.project === null || query.project === "inbox" || projects.some((p) => p.id === query.project);
  const { tasks, truncated } = knownProject
    ? await searchTasks(user.id, query, today)
    : { tasks: [], truncated: false };

  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const filterProjects = [
    ...projects.filter((p) => p.archivedAt === null).map((p) => ({ id: p.id, name: p.name })),
    ...projects.filter((p) => p.archivedAt !== null).map((p) => ({ id: p.id, name: `${p.name} (archived)` })),
  ];
  // The editor's project picker offers active projects only, as in the Inbox.
  const editorProjects = projects.filter((p) => p.archivedAt === null).map((p) => ({ id: p.id, name: p.name }));
  const filtering = hasActiveFilters(query);

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Search</h1>
      <SearchFilters
        // The select falls back to "All projects"; an unknown id is never echoed back.
        query={knownProject ? query : { ...query, project: null }}
        projects={filterProjects}
      />
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm text-stone-500">
        <p aria-live="polite">
          {tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}
          {truncated && ` · Showing the first ${SEARCH_LIMIT} results, narrow your search`}
        </p>
        {filtering && (
          <Link href="/search" className="shrink-0 rounded-md px-2 py-1 hover:bg-stone-100 hover:text-stone-900">
            Clear filters
          </Link>
        )}
      </div>
      {tasks.length > 0 ? (
        <ul aria-label="Search results">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={toTaskView(task)}
              projects={editorProjects}
              taskOptions={taskOptions}
              today={today}
              projectLabel={task.projectId === null ? "Inbox" : projectNames.get(task.projectId)}
            />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-stone-500">No tasks match.</p>
      )}
    </section>
  );
}
