import { prisma } from "@/lib/db";

export type LimitMetric = "wa_messages" | "emails" | "ai_calls" | "contacts" | "team_seats" | "automations";

export class PlanLimitError extends Error {
  name = "PlanLimitError";
  constructor(
    public metric: LimitMetric,
    public limit: number,
    public used: number,
    public reason: "limit" | "trial_expired" = "limit"
  ) {
    super(
      reason === "trial_expired"
        ? "Your free trial has ended. Upgrade to continue."
        : `You've reached your plan limit for ${metric} (${used}/${limit}). Upgrade to continue.`
    );
  }
}

export function currentMonth(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

const USAGE_FIELD = {
  wa_messages: "wa_sent",
  emails: "emails_sent",
  ai_calls: "ai_calls_made",
  contacts: "contacts_created",
} as const;

const LIMIT_FIELD = {
  wa_messages: "max_wa_messages_mo",
  emails: "max_emails_mo",
  ai_calls: "max_ai_calls_mo",
  contacts: "max_contacts",
  team_seats: "max_team_seats",
  automations: "max_automations",
} as const;

/** True when the org is on the free plan, past trial_ends_at, with no active subscription. */
export async function isTrialExpired(orgId: string): Promise<boolean> {
  const org = await prisma.organisations.findUnique({
    where: { id: orgId },
    select: { plan: true, trial_ends_at: true },
  });
  if (!org) return true;
  if (org.plan !== "free") return false;
  if (!org.trial_ends_at || org.trial_ends_at > new Date()) return false;
  const active = await prisma.subscriptions.count({ where: { org_id: orgId, status: "active" } });
  return active === 0;
}

/**
 * Throws PlanLimitError when `count` more units of `metric` would exceed the org's plan.
 * Call before every send / import / create. `count` defaults to 1.
 */
export async function checkLimit(orgId: string, metric: LimitMetric, count = 1): Promise<void> {
  const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { plan: true } });
  if (!org) throw new PlanLimitError(metric, 0, 0);
  if (await isTrialExpired(orgId)) throw new PlanLimitError(metric, 0, 0, "trial_expired");

  const limits = await prisma.plan_limits.findUnique({ where: { plan: org.plan } });
  if (!limits) throw new Error(`plan_limits not seeded for plan ${org.plan} (run pnpm db:seed)`);
  const limit = limits[LIMIT_FIELD[metric]];

  let used: number;
  if (metric === "team_seats") used = await prisma.users.count({ where: { org_id: orgId, is_active: true } });
  else if (metric === "automations") used = await prisma.automations.count({ where: { org_id: orgId } });
  else if (metric === "contacts") used = await prisma.contacts.count({ where: { org_id: orgId, is_active: true } });
  else {
    const u = await prisma.usage.findUnique({ where: { org_id_month: { org_id: orgId, month: currentMonth() } } });
    used = u ? u[USAGE_FIELD[metric]] : 0;
  }

  if (used + count > limit) throw new PlanLimitError(metric, limit, used);
}

/** Atomic monthly usage increment (upsert). */
export async function incrementUsage(
  orgId: string,
  metric: Exclude<LimitMetric, "team_seats" | "automations"> | "automations_triggered",
  by = 1
): Promise<void> {
  const field = metric === "automations_triggered" ? "automations_triggered" : USAGE_FIELD[metric];
  const month = currentMonth();
  await prisma.usage.upsert({
    where: { org_id_month: { org_id: orgId, month } },
    create: { org_id: orgId, month, [field]: by },
    update: { [field]: { increment: by } },
  });
}

export async function getUsageSummary(orgId: string) {
  const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { plan: true, trial_ends_at: true } });
  if (!org) return null;
  const [limits, usage, seats, automations, contacts] = await Promise.all([
    prisma.plan_limits.findUnique({ where: { plan: org.plan } }),
    prisma.usage.findUnique({ where: { org_id_month: { org_id: orgId, month: currentMonth() } } }),
    prisma.users.count({ where: { org_id: orgId, is_active: true } }),
    prisma.automations.count({ where: { org_id: orgId } }),
    prisma.contacts.count({ where: { org_id: orgId, is_active: true } }),
  ]);
  if (!limits) return null;
  return {
    plan: org.plan,
    trial_ends_at: org.trial_ends_at,
    metrics: {
      wa_messages: { used: usage?.wa_sent ?? 0, limit: limits.max_wa_messages_mo },
      emails: { used: usage?.emails_sent ?? 0, limit: limits.max_emails_mo },
      ai_calls: { used: usage?.ai_calls_made ?? 0, limit: limits.max_ai_calls_mo },
      contacts: { used: contacts, limit: limits.max_contacts },
      team_seats: { used: seats, limit: limits.max_team_seats },
      automations: { used: automations, limit: limits.max_automations },
    },
  };
}
