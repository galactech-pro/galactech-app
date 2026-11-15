import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { prisma, type plan } from "@/lib/db";
import { ApiError } from "@/lib/api";

export const PAID_PLANS = ["starter", "growth", "pro"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

const DEFAULT_PRICE: Record<PaidPlan, number> = { starter: 999, growth: 2999, pro: 7999 };

export function getRazorpay(): Razorpay {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) throw new ApiError(400, "Billing is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing)");
  return new Razorpay({ key_id, key_secret });
}

/** Verifies X-Razorpay-Signature (HMAC-SHA256 hex of the RAW body). */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns the Razorpay plan id for a paid plan, creating it via the Plans API (and persisting) when missing. */
export async function ensureRazorpayPlan(p: PaidPlan): Promise<string> {
  const row = await prisma.plan_limits.findUnique({ where: { plan: p } });
  if (row?.razorpay_plan_id) return row.razorpay_plan_id;
  const rz = getRazorpay();
  const price = row?.price_monthly_inr || DEFAULT_PRICE[p];
  const created = await rz.plans.create({
    period: "monthly",
    interval: 1,
    item: { name: `GalacTech ${p[0].toUpperCase()}${p.slice(1)}`, amount: price * 100, currency: "INR", description: `${p} plan, billed monthly` },
    notes: { plan: p },
  });
  if (row) await prisma.plan_limits.update({ where: { plan: p }, data: { razorpay_plan_id: created.id } });
  return created.id;
}

/** Reuse the org's Razorpay customer id from any prior subscription, else create one. */
export async function ensureCustomer(orgId: string, email: string, name: string): Promise<string> {
  const prev = await prisma.subscriptions.findFirst({
    where: { org_id: orgId, razorpay_customer_id: { not: null } },
    orderBy: { current_period_start: "desc" },
    select: { razorpay_customer_id: true },
  });
  if (prev?.razorpay_customer_id) return prev.razorpay_customer_id;
  const c = await getRazorpay().customers.create({ name, email, fail_existing: 0, notes: { org_id: orgId } });
  return c.id;
}

export async function planFromRazorpayPlanId(razorpayPlanId: string | undefined): Promise<plan | null> {
  if (!razorpayPlanId) return null;
  const row = await prisma.plan_limits.findFirst({ where: { razorpay_plan_id: razorpayPlanId } });
  return row?.plan ?? null;
}
