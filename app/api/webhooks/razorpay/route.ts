import { NextResponse, type NextRequest } from "next/server";
import { prisma, type plan, type subscription_status } from "@/lib/db";
import { sendEvent } from "@/lib/inngest";
import { audit } from "@/lib/audit";
import { claimWebhookEvent, markProcessed, releaseWebhookEvent } from "@/lib/webhook-dedup";
import { limitOrResponse, clientIp } from "@/lib/rate-limit";
import { planFromRazorpayPlanId, verifyWebhookSignature } from "@/lib/razorpay";

export const runtime = "nodejs";

interface SubEntity {
  id: string;
  plan_id?: string;
  customer_id?: string;
  current_start?: number | null;
  current_end?: number | null;
  notes?: Record<string, string> | unknown[];
}
interface PayEntity {
  id: string;
  amount: number;
  invoice_id?: string | null;
  status?: string;
}
interface RzEvent {
  event: string;
  /** unix seconds; used only for ordering guards (UNVERIFIED that every event carries it, so it is optional). */
  created_at?: number;
  payload: { subscription?: { entity: SubEntity }; payment?: { entity: PayEntity } };
}

const toDate = (s?: number | null) => (s ? new Date(s * 1000) : null);

async function handle(ev: RzEvent) {
  const subE = ev.payload.subscription?.entity;
  if (!subE) return;
  // tenant-ok: looked up by Razorpay's globally unique subscription id; org_id is then taken from the row
  let sub = await prisma.subscriptions.findUnique({ where: { razorpay_sub_id: subE.id } });
  const notes = (Array.isArray(subE.notes) ? {} : subE.notes ?? {}) as Record<string, string>;
  const orgId = sub?.org_id ?? notes.org_id;
  if (!orgId) return;
  const planFromId = await planFromRazorpayPlanId(subE.plan_id);
  const newPlan = (planFromId ?? (notes.plan as plan | undefined) ?? sub?.plan) as plan | undefined;
  if (!newPlan) return;

  const wasActive = sub?.status === "active";
  // M-10(b): a late charged/activated that predates our recorded cancellation must not re-activate the org.
  if ((ev.event === "subscription.activated" || ev.event === "subscription.charged") && ev.created_at && sub?.status === "cancelled" && sub.cancelled_at && ev.created_at * 1000 < sub.cancelled_at.getTime()) {
    console.warn("[razorpay webhook] ignoring out-of-order", ev.event);
    return;
  }

  const setStatus = async (status: subscription_status) => {
    const data = {
      plan: newPlan,
      status,
      razorpay_customer_id: subE.customer_id ?? sub?.razorpay_customer_id ?? null,
      current_period_start: toDate(subE.current_start) ?? sub?.current_period_start ?? null,
      current_period_end: toDate(subE.current_end) ?? sub?.current_period_end ?? null,
    };
    sub = sub
      ? await prisma.subscriptions.update({ where: { id: sub.id, org_id: orgId }, data: { ...data, ...(status === "cancelled" ? { cancelled_at: new Date() } : {}) } })
      : await prisma.subscriptions.create({ data: { org_id: orgId, razorpay_sub_id: subE.id, ...data } });
  };

  switch (ev.event) {
    case "subscription.activated":
    case "subscription.charged": {
      await setStatus("active");
      await prisma.organisations.update({ where: { id: orgId }, data: { plan: newPlan } });
      const pay = ev.payload.payment?.entity;
      let invoiceCreated = false;
      if (pay) {
        const invId = pay.invoice_id ?? pay.id;
        // tenant-ok: razorpay_invoice_id is globally unique
        invoiceCreated = !(await prisma.invoices.findUnique({ where: { razorpay_invoice_id: invId }, select: { id: true } }));
        await prisma.invoices.upsert({
          where: { razorpay_invoice_id: invId },
          update: {},
          create: {
            org_id: orgId,
            subscription_id: sub!.id,
            amount_inr: pay.amount / 100,
            status: "paid",
            razorpay_invoice_id: invId,
            paid_at: new Date(),
          },
        });
      }
      await audit({ org_id: orgId }, ev.event, "subscription", subE.id, { after: { plan: newPlan } });
      // M-10(c): only announce a payment once (new invoice, or first activation without a payment entity)
      if (invoiceCreated || (!pay && !wasActive)) await sendEvent("payment/succeeded", { org_id: orgId, plan: newPlan });
      break;
    }
    case "subscription.pending":
      await setStatus("past_due");
      await audit({ org_id: orgId }, ev.event, "subscription", subE.id);
      break;
    case "subscription.halted": // retries exhausted: restrict paid features (M-10a); a later charged/activated restores the plan
      await setStatus("past_due");
      await prisma.organisations.update({ where: { id: orgId }, data: { plan: "free" } });
      await audit({ org_id: orgId }, ev.event, "subscription", subE.id, { after: { plan: "free" } });
      break;
    case "subscription.cancelled":
    case "subscription.completed":
      await setStatus("cancelled");
      await prisma.organisations.update({ where: { id: orgId }, data: { plan: "free" } });
      await audit({ org_id: orgId }, ev.event, "subscription", subE.id, { after: { plan: "free" } });
      break;
    default:
      break;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text(); // RAW body — signature is computed over the exact bytes
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"))) {
    return NextResponse.json({ success: false, data: null, error: "Invalid signature" }, { status: 401 });
  }
  let ev: RzEvent;
  try {
    ev = JSON.parse(raw) as RzEvent;
  } catch {
    return NextResponse.json({ success: false, data: null, error: "Invalid JSON" }, { status: 400 });
  }
  const eventId = req.headers.get("x-razorpay-event-id");
  const limited = await limitOrResponse(`rzp-wh:${clientIp(req)}`, { limit: 300, windowSec: 60 });
  if (limited) return limited;
  if (eventId && !(await claimWebhookEvent("razorpay", eventId))) {
    return NextResponse.json({ success: true, data: { duplicate: true }, error: null });
  }
  try {
    await handle(ev);
    if (eventId) await markProcessed("razorpay", eventId);
  } catch (e) {
    // Return 500 so Razorpay retries; release the claim so the retry is processed. Handlers stay idempotent.
    if (eventId) await releaseWebhookEvent("razorpay", eventId).catch(() => undefined);
    console.error("[razorpay webhook]", ev.event, e);
    return NextResponse.json({ success: false, data: null, error: "Handler error" }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: null, error: null });
}
