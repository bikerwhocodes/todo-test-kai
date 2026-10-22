import type { Metadata } from "next";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Today · NextUp" };

export default async function TodayPage() {
  // Layouts don't re-run on client navigation, so each page checks too.
  const user = await requireUser();
  const settings = await getUserSettings(user.id);
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  return (
    <section>
      <h1 className="text-xl font-semibold">Today</h1>
      <p className="mt-1 text-sm text-stone-600">
        {today} · {settings.timeZone}
      </p>
    </section>
  );
}
