import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { limitOrResponse } from "@/lib/rate-limit";
import { ensureCustomer, ensureRazorpayPlan, getRazorpay, PAID_PLANS } from "@/lib/razorpay";

const Schema = z.object({ plan: z.enum(PAID_PLANS) });

/** POST {plan} → {subscription_id, key_id} for Razorpay Checkout (plan activates via webhook). */
export const POST = withAuth(
  async (req, session) => {
    const limited = await limitOrResponse(`billing-upgrade:${session.org_id}`, { limit: 10, windowSec: 3600 });
    if (limited) return limited;
    const { plan } = await parseBody(req, Schema);
    const active = await prisma.subscriptions.findFirst({ where: { org_id: session.org_id, status: "active" } });
    if (active && active.plan === plan) return fail("You are already on this plan", 409);
    if (active?.razorpay_sub_id) return fail("Cancel your current subscription before switching plans", 409);

    const org = await prisma.organisations.findUnique({ where: { id: session.org_id }, select: { name: true } });
    const rz = getRazorpay();
    const [planId, customerId] = await Promise.all([
      ensureRazorpayPlan(plan),
      ensureCustomer(session.org_id, session.user.email, org?.name ?? session.user.email),
    ]);
    const sub = await rz.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: 120,
      notes: { org_id: session.org_id, plan },
    });
    await prisma.subscriptions.create({
      data: { org_id: session.org_id, plan, status: "trialing", razorpay_sub_id: sub.id, razorpay_customer_id: customerId },
    });
    await audit(session, "billing.upgrade_start", "subscription", sub.id, { after: { plan } });
    return ok({ subscription_id: sub.id, key_id: process.env.RAZORPAY_KEY_ID });
  },
  { role: "admin" }
);
