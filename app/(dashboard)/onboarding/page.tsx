import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Wizard } from "./wizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const org = await prisma.organisations.findUnique({
    where: { id: session.org_id },
    select: { name: true, timezone: true, language: true, onboarding_step: true, onboarding_done: true },
  });
  if (!org || org.onboarding_done) redirect("/dashboard");
  return (
    <Wizard
      initial={{ name: org.name, timezone: org.timezone, language: org.language, step: Math.min(org.onboarding_step, 4) }}
    />
  );
}
