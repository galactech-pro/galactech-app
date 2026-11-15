import { withAuth, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { getUsageSummary, isTrialExpired } from "@/lib/limits";

export const GET = withAuth(async (_req, session) => {
  const [usage, subscription, invoices, trialExpired, plans] = await Promise.all([
    getUsageSummary(session.org_id),
    prisma.subscriptions.findFirst({
      where: { org_id: session.org_id, status: { in: ["active", "past_due", "trialing"] } },
      orderBy: { current_period_start: { sort: "desc", nulls: "last" } }, // M-20: abandoned checkout rows have NULL period start; Postgres sorts NULLs first on DESC
    }),
    prisma.invoices.findMany({ where: { org_id: session.org_id }, orderBy: { issued_at: "desc" }, take: 50 }),
    isTrialExpired(session.org_id),
    prisma.plan_limits.findMany({ orderBy: { price_monthly_inr: "asc" } }),
  ]);
  const trial_days_left =
    usage?.trial_ends_at && usage.plan === "free"
      ? Math.max(0, Math.ceil((usage.trial_ends_at.getTime() - Date.now()) / 86400_000))
      : null;
  return ok({
    plan: session.plan,
    usage,
    trial: { ends_at: usage?.trial_ends_at ?? null, days_left: trial_days_left, expired: trialExpired },
    subscription: subscription
      ? { id: subscription.id, plan: subscription.plan, status: subscription.status, current_period_end: subscription.current_period_end, cancelled_at: subscription.cancelled_at }
      : null,
    invoices,
    plans: plans.map((p) => ({
      plan: p.plan, price_monthly_inr: p.price_monthly_inr, price_annual_inr: p.price_annual_inr, features: p.features,
      limits: { contacts: p.max_contacts, wa_messages: p.max_wa_messages_mo, emails: p.max_emails_mo, ai_calls: p.max_ai_calls_mo, team_seats: p.max_team_seats, automations: p.max_automations },
    })),
    razorpay_key_id: process.env.RAZORPAY_KEY_ID ?? null,
  });
});
