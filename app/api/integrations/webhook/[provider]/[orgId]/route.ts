import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { safe, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";
import { claimWebhookEvent, markProcessed, releaseWebhookEvent } from "@/lib/webhook-dedup";
import { InboundContact, upsertInboundContact } from "@/app/api/public/_contact";

type Provider = "typeform" | "shopify" | "woocommerce";
const ProviderSchema = z.enum(["typeform", "shopify", "woocommerce"]);

/** Header carrying the base64 HMAC-SHA256 of the raw body, per provider. */
const SIG_HEADER: Record<Provider, string> = {
  typeform: "typeform-signature", // "sha256=<base64>"
  shopify: "x-shopify-hmac-sha256",
  woocommerce: "x-wc-webhook-signature",
};

function verify(provider: Provider, raw: string, req: NextRequest, secret: string): boolean {
  let sig = req.headers.get(SIG_HEADER[provider]);
  if (!sig) return false;
  if (provider === "typeform") sig = sig.replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret).update(raw).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

function mapTypeform(body: Rec): Partial<InboundContact> {
  const answers = (rec(body.form_response).answers as Rec[] | undefined) ?? [];
  let phone: string | undefined, email: string | undefined, name: string | undefined, company: string | undefined;
  for (const a of answers) {
    const type = a.type as string;
    const title = str(rec(a.field).title)?.toLowerCase() ?? "";
    if (type === "phone_number") phone ??= str(a.phone_number);
    else if (type === "email") email ??= str(a.email);
    else if (type === "text") {
      const t = str(a.text);
      if (/company|organi[sz]ation/.test(title)) company ??= t;
      else if (/name/.test(title)) name ??= t;
    }
  }
  return { phone, email, company, full_name: name ?? email };
}

function mapShopify(body: Rec): Partial<InboundContact> {
  const cust = rec(body.customer ?? body);
  const addr = rec(cust.default_address ?? body.billing_address);
  const name = [str(cust.first_name), str(cust.last_name)].filter(Boolean).join(" ");
  return {
    phone: str(cust.phone) ?? str(body.phone) ?? str(addr.phone),
    email: str(cust.email) ?? str(body.email),
    company: str(addr.company),
    full_name: name || str(addr.name) || str(cust.email) || str(body.email),
  };
}

function mapWoo(body: Rec): Partial<InboundContact> {
  const b = rec(body.billing ?? body);
  const name = [str(b.first_name), str(b.last_name)].filter(Boolean).join(" ");
  return { phone: str(b.phone), email: str(b.email), company: str(b.company), full_name: name || str(b.email) };
}

/** Public receiver. Signature-verified; always 200 on valid-but-unusable payloads so providers don't retry. */
export const POST = safe<{ provider: string; orgId: string }>(async (req, ctx) => {
  const params = await ctx.params;
  const p = ProviderSchema.safeParse(params.provider);
  if (!p.success || !z.string().uuid().safeParse(params.orgId).success) return fail("Not found", 404);
  const provider = p.data;

  // Abuse control before any DB/crypto work. Keyed by IP + org so one noisy sender cannot starve another org.
  const limited = await limitOrResponse(`intwh:${clientIp(req)}:${params.orgId}`, { limit: 120, windowSec: 60 });
  if (limited) return limited;

  const integ = await prisma.integrations.findUnique({ where: { org_id_provider: { org_id: params.orgId, provider } } });
  // L-04: identical answer whether the integration is missing or the signature is wrong (do not reveal existence).
  if (!integ || !integ.is_active) return fail("Invalid signature", 401);

  const raw = await req.text();
  let secret: string | undefined;
  try {
    secret = (JSON.parse(decrypt(integ.config)) as { secret?: string }).secret;
  } catch {
    return fail("Integration misconfigured", 500);
  }
  if (!secret || !verify(provider, raw, req, secret)) return fail("Invalid signature", 401);

  let body: Rec;
  try {
    body = rec(JSON.parse(raw));
  } catch {
    return fail("Invalid JSON", 400);
  }
  // Dedup on the provider delivery id (Shopify X-Shopify-Webhook-Id; WooCommerce X-WC-Webhook-Delivery-ID and Typeform
  // body.event_id are UNVERIFIED names, see docs/SECURITY.md). No id => no dedup (the contact upsert is idempotent anyway).
  const deliveryId =
    provider === "shopify" ? req.headers.get("x-shopify-webhook-id") :
    provider === "woocommerce" ? req.headers.get("x-wc-webhook-delivery-id") :
    str(body.event_id) ?? null;
  const dedupProvider = `integration:${provider}`;
  const dedupKey = deliveryId ? `${params.orgId}:${deliveryId.slice(0, 200)}` : null;
  if (dedupKey && !(await claimWebhookEvent(dedupProvider, dedupKey, params.orgId))) return ok({ duplicate: true });

  try {
  const mapped = provider === "typeform" ? mapTypeform(body) : provider === "shopify" ? mapShopify(body) : mapWoo(body);
  const parsed = InboundContact.safeParse({ ...mapped, source: provider });
  if (!parsed.success) {
    if (dedupKey) await markProcessed(dedupProvider, dedupKey);
    return ok({ ignored: "Payload had no usable name/phone" });
  }

  const { contact, created } = await upsertInboundContact(params.orgId, parsed.data, provider);
  await prisma.integrations.update({ where: { id: integ.id, org_id: params.orgId }, data: { last_sync_at: new Date() } });
  if (dedupKey) await markProcessed(dedupProvider, dedupKey);
  return ok({ id: contact.id, created });
  } catch (e) {
    if (dedupKey) await releaseWebhookEvent(dedupProvider, dedupKey).catch(() => undefined); // let the provider retry
    throw e;
  }
});
