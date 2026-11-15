import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DashboardView } from "./dashboard-view";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const org = await prisma.organisations.findUnique({ where: { id: session.org_id }, select: { onboarding_done: true } });
  if (!org?.onboarding_done) redirect("/onboarding");
  return <DashboardView name={session.user.full_name?.split(/\s+/)[0] ?? null} />;
}
