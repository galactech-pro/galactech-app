import { prisma, Prisma } from "@/lib/db";
import { PlanLimitError, currentMonth, isTrialExpired } from "@/lib/limits";

export type MeteredMetric = "wa_messages" | "emails" | "ai_calls";

// Whitelisted identifiers (never interpolate user input into SQL identifiers).
const USAGE_COL = { wa_messages: "wa_sent", emails: "emails_sent", ai_calls: "ai_calls_made" } as const;
const LIMIT_FIELD = { wa_messages: "max_wa_messages_mo", emails: "max_emails_mo", ai_calls: "max_ai_calls_mo" } as const;

const monthIso = () => currentMonth().toISOString().slice(0, 10);

/**
 * M-01: atomic reservation. ONE conditional UPDATE ... SET n = n + k WHERE n + k <= limit RETURNING - concurrent
 * senders cannot overshoot the plan. Throws PlanLimitError (never partially reserves). Call releaseUsage() when the
 * provider definitively rejected the send. Replaces checkLimit()+incrementUsage() on every send path.
 */
export async function reserveUsage(orgId: string, metric: MeteredMetric, n = 1): Promise<void> {
  const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { plan: true } });
  if (!org) throw new PlanLimitError(metric, 0, 0);
  if (await isTrialExpired(orgId)) throw new PlanLimitError(metric, 0, 0, "trial_expired");
  const limits = await prisma.plan_limits.findUnique({ where: { plan: org.plan } });
  if (!limits) throw new Error(`plan_limits not seeded for plan ${org.plan} (run pnpm db:seed)`);
  const limit = limits[LIMIT_FIELD[metric]];
  const col = Prisma.raw(`"${USAGE_COL[metric]}"`);
  const month = monthIso();

  await prisma.$executeRaw`INSERT INTO "usage" (id, org_id, month) VALUES (gen_random_uuid(), ${orgId}::uuid, ${month}::date) ON CONFLICT (org_id, month) DO NOTHING`;
  const rows = await prisma.$queryRaw<{ used: number }[]>(
    Prisma.sql`UPDATE "usage" SET ${col} = ${col} + ${n}::int WHERE org_id = ${orgId}::uuid AND month = ${month}::date AND ${col} + ${n}::int <= ${limit}::int RETURNING ${col} AS used`
  );
  if (rows.length === 0) {
    const u = await prisma.usage.findUnique({ where: { org_id_month: { org_id: orgId, month: currentMonth() } } });
    throw new PlanLimitError(metric, limit, u ? u[USAGE_COL[metric]] : 0);
  }
}

/** Give back a reservation (definitive provider failure). Never goes below zero. */
export async function releaseUsage(orgId: string, metric: MeteredMetric, n = 1): Promise<void> {
  const col = Prisma.raw(`"${USAGE_COL[metric]}"`);
  await prisma.$executeRaw(Prisma.sql`UPDATE "usage" SET ${col} = GREATEST(${col} - ${n}::int, 0) WHERE org_id = ${orgId}::uuid AND month = ${monthIso()}::date`);
}
