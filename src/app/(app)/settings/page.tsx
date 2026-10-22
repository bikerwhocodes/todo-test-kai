import type { Metadata } from "next";
import { timeZoneOptions } from "@/core/time-zone";
import { SettingsForm } from "@/components/settings/settings-form";
import { getUserSettings } from "@/server/repo/user-settings";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Settings · NextUp" };

export default async function SettingsPage() {
  const user = await requireUser();
  const settings = await getUserSettings(user.id);

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      <SettingsForm
        settings={{ timeZone: settings.timeZone, defaultEstimateMin: settings.defaultEstimateMin }}
        zones={timeZoneOptions(settings.timeZone)}
      />
    </section>
  );
}
