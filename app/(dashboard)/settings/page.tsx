import { SettingsView } from "@/components/app/settings/settings-view";
import { OutreachCard } from "@/components/app/settings/outreach-card";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <SettingsView />
      <OutreachCard />
    </>
  );
}
