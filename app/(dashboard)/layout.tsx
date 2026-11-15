import { redirect } from "next/navigation";
import { Shell } from "@/components/app/shell";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const org = await prisma.organisations.findUnique({
    where: { id: session.org_id },
    select: { name: true, plan: true, trial_ends_at: true },
  });

  return (
    <Shell
      orgName={org?.name ?? "Workspace"}
      userName={session.user.full_name}
      email={session.user.email}
      plan={org?.plan ?? session.plan}
      trialEndsAt={org?.trial_ends_at ? org.trial_ends_at.toISOString() : null}
      emailVerified={session.user.email_verified}
    >
      {children}
    </Shell>
  );
}
