"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string };

/** Horizontal scroll row on small screens, vertical list from md up. */
export function NavLinks({ primary, projects }: { primary: NavItem[]; projects: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
        {primary.map((item) => (
          <NavLink key={item.href} item={item} active={pathname === item.href} />
        ))}
        {projects.length > 0 && (
          <li
            aria-hidden
            className="mx-1 w-px shrink-0 self-stretch bg-stone-200 md:mx-0 md:my-2 md:h-px md:w-auto"
          />
        )}
        {projects.map((item) => (
          <NavLink key={item.href} item={item} active={pathname === item.href} />
        ))}
      </ul>
    </nav>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <li className="shrink-0">
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`block max-w-48 truncate rounded-md px-3 py-1.5 text-sm ${
          active ? "bg-stone-200 font-medium text-stone-900" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
        }`}
      >
        {item.label}
      </Link>
    </li>
  );
}
