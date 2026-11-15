import { Suspense } from "react";
import { InboxView } from "@/components/app/inbox/inbox-view";

export const metadata = { title: "Inbox" };

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxView />
    </Suspense>
  );
}
