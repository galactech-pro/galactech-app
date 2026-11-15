import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getRazorpay } from "@/lib/razorpay";
import { limitOrResponse } from "@/lib/rate-limit";

/** Cancels at period end; the webhook (subscription.cancelled) downgrades the org to free when it actually ends. */
export const POST = withAuth(
  async (_req, session) => {
    const limited = await limitOrResponse(`billing-cancel:${session.org_id}`, { limit: 10, windowSec: 3600 });
    if (limited) return limited;
    const sub = await prisma.subscriptions.findFirst({
      where: { org_id: session.org_id, status: { in: ["active", "past_due"] }, razorpay_sub_id: { not: null } },
      orderBy: { current_period_start: { sort: "desc", nulls: "last" } },
    });
    if (!sub?.razorpay_sub_id) return fail("No active subscription", 404);
    await getRazorpay().subscriptions.cancel(sub.razorpay_sub_id, true);
    await prisma.subscriptions.update({ where: { id: sub.id, org_id: session.org_id }, data: { cancelled_at: new Date() } });
    await audit(session, "billing.cancel", "subscription", sub.id, { before: { plan: sub.plan } });
    return ok({ cancel_at_period_end: true, current_period_end: sub.current_period_end });
  },
  { role: "admin" }
);
