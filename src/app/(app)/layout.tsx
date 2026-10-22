import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { KeyboardShortcuts } from "@/components/keyboard/keyboard-shortcuts";
import { NavLinks } from "@/components/projects/nav-links";
import { NewProjectForm } from "@/components/projects/new-project-form";
import { SearchShortcut } from "@/components/search/search-shortcut";
import { TimeZoneBanner } from "@/components/settings/time-zone-banner";
import { focusRingClass } from "@/components/ui";
import { listProjects } from "@/server/repo/projects";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [projects, settings] = await Promise.all([listProjects(user.id), getUserSettings(user.id)]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4">
      <header className="flex items-center justify-between py-4">
        <span className="font-semibold tracking-tight">NextUp</span>
        <div className="flex items-center gap-3 text-sm text-stone-600">
          <span className="hidden sm:inline">{user.email}</span>
          <KeyboardShortcuts />
          <Link
            href="/settings"
            className={`rounded-md px-2 py-1 hover:bg-stone-200 hover:text-stone-900 ${focusRingClass}`}
          >
            Settings
          </Link>
          <SignOutButton />
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row md:gap-8">
        <aside className="space-y-2 border-b border-stone-200 pb-3 md:w-52 md:shrink-0 md:border-b-0 md:pb-0">
          <NavLinks
            primary={[
              { href: "/today", label: "Today" },
              { href: "/upcoming", label: "Upcoming" },
              { href: "/inbox", label: "Inbox" },
              { href: "/search", label: "Search" },
              { href: "/recurring", label: "Recurring" },
            ]}
            projects={projects.map((p) => ({ href: `/projects/${p.id}`, label: p.name }))}
          />
          <div className="flex items-start justify-between gap-2 md:flex-col">
            <div className="min-w-0 flex-1 md:w-full">
              <NewProjectForm />
            </div>
            <Link
              href="/projects/archived"
              className={`rounded-md px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-100 hover:text-stone-900 ${focusRingClass}`}
            >
              Archived
            </Link>
          </div>
        </aside>
        <main className="min-w-0 flex-1 py-6 md:max-w-3xl md:pt-0">
          <TimeZoneBanner profileZone={settings.timeZone} />
          {children}
        </main>
      </div>
      <SearchShortcut />
    </div>
  );
}
