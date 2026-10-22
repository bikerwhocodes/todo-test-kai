import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { z } from "zod";
import { localToday } from "@/core/dates";
import { ProjectHeader } from "@/components/projects/project-header";
import { QuickAdd } from "@/components/tasks/quick-add";
import { TaskList } from "@/components/tasks/task-list";
import { toTaskView } from "@/components/tasks/types";
import { getProject, listProjects } from "@/server/repo/projects";
import { occurrenceBadges } from "@/server/repo/series";
import { listProjectTasks } from "@/server/repo/tasks";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

type Props = { params: Promise<{ id: string }> };

// Shared by generateMetadata and the page. A non-uuid id would make Postgres throw.
const loadProject = cache(async (id: string) => {
  const user = await requireUser();
  if (!z.uuid().safeParse(id).success) return null;
  return getProject(user.id, id);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const project = await loadProject((await params).id);
  return { title: `${project?.name ?? "Project"} · NextUp` };
}

export default async function ProjectPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser();
  const project = await loadProject(id);
  if (!project) notFound();

  const [tasks, projects, settings] = await Promise.all([
    listProjectTasks(user.id, project.id),
    listProjects(user.id),
    getUserSettings(user.id),
  ]);
  const today = localToday(settings.timeZone, new Date());
  const badges = await occurrenceBadges(user.id, [...tasks.open, ...tasks.done], today);
  const archived = project.archivedAt !== null;
  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));
  // Archived projects are left out of listProjects; keep this one selectable for its own tasks.
  if (archived) projectOptions.push({ id: project.id, name: `${project.name} (archived)` });

  return (
    <section>
      <ProjectHeader key={project.id} id={project.id} name={project.name} archived={archived} />
      {archived ? (
        <p className="mb-6 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700">
          This project is archived. Unarchive it to add tasks or move tasks into it.
        </p>
      ) : (
        <QuickAdd key={project.id} projectId={project.id} placeholder={`Add a task to ${project.name}…`} />
      )}
      <TaskList
        open={tasks.open.map((t) => toTaskView(t, badges.get(t.id)))}
        done={tasks.done.map((t) => toTaskView(t, badges.get(t.id)))}
        projects={projectOptions}
        today={today}
        emptyText={archived ? "No open tasks." : "No open tasks. Add one above."}
      />
    </section>
  );
}
