import type { Metadata } from "next";
import Link from "next/link";
import { ArchiveButton } from "@/components/projects/archive-button";
import { listProjects } from "@/server/repo/projects";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Archived projects · NextUp" };

export default async function ArchivedProjectsPage() {
  const user = await requireUser();
  const archived = (await listProjects(user.id, { includeArchived: true })).filter((p) => p.archivedAt !== null);

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Archived projects</h1>
      {archived.length === 0 ? (
        <p className="py-6 text-center text-sm text-stone-500">No archived projects.</p>
      ) : (
        <ul>
          {archived.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 border-b border-stone-200 py-2 last:border-b-0"
            >
              <Link href={`/projects/${p.id}`} className="min-w-0 truncate hover:underline">
                {p.name}
              </Link>
              <ArchiveButton id={p.id} name={p.name} archived />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
