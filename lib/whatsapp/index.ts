import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { Purpose } from "@/lib/compliance";
import { campaignKey, sendOutbound } from "@/lib/channels/outbound";
import { toApiError } from "@/lib/channels/errors";
import type { OutboundContent } from "@/lib/channels/types";
import { getCreds, graphRead } from "./graph";

export { isOptOutKeyword, parseWebhook, verifySignature, type InboundMsg, type StatusUpdate } from "./webhook";

export interface SendCtx {
  contactId: string;
  campaignId?: string;
  /** Default: "marketing" for campaign sends, otherwise "service". Pass "marketing" for promotional automation sends. */
  purpose?: Purpose;
  /** True for automations/workflows/AI-initiated sends (needs org.auto_outreach_enabled for marketing). */
  automated?: boolean;
  /**
   * Stable key for this business operation (e.g. automationKey(runId, stepId, contactId)). Without it non-campaign sends
   * get a random key, i.e. NO protection against an Inngest step retry re-sending.
   */
  idempotencyKey?: string;
  inboxId?: string;
  /** Template language code (default env WA_TEMPLATE_LANGUAGE or "en"). */
  language?: string;
}
export interface SendResult {
  messageId: string;
  waMessageId: string;
}

/** All WhatsApp sends go through the shared outbound pipeline (compliance, window, atomic limits, outbox, idempotency). */
async function dispatch(orgId: string, phone: string, content: OutboundContent, ctx?: SendCtx): Promise<SendResult> {
  let contactId = ctx?.contactId;
  if (!contactId) {
    const c = await prisma.contacts.findFirst({ where: { org_id: orgId, phone, is_active: true }, select: { id: true } });
    if (!c) throw new ApiError(404, "Contact not found");
    contactId = c.id;
  }
  try {
    const r = await sendOutbound({
      orgId,
      contactId,
      channel: "whatsapp",
      inboxId: ctx?.inboxId,
      content,
      purpose: ctx?.purpose ?? (ctx?.campaignId ? "marketing" : "service"),
      automated: ctx?.automated,
      campaignId: ctx?.campaignId,
      idempotencyKey: ctx?.idempotencyKey ?? (ctx?.campaignId ? campaignKey(ctx.campaignId, contactId) : randomUUID()),
    });
    return { messageId: r.message.id, waMessageId: r.message.external_id ?? r.message.wa_message_id ?? "" };
  } catch (e) {
    throw toApiError(e, "WhatsApp send");
  }
}

export function sendMessage(orgId: string, phone: string, text: string, ctx?: SendCtx): Promise<SendResult> {
  return dispatch(orgId, phone, { kind: "text", text }, ctx);
}

export function sendTemplate(orgId: string, phone: string, templateName: string, params: string[], ctx?: SendCtx): Promise<SendResult> {
  return dispatch(orgId, phone, { kind: "template", name: templateName, params, language: ctx?.language }, ctx);
}

export function sendMedia(
  orgId: string,
  phone: string,
  media: { type: "image" | "document" | "video" | "audio"; url: string; caption?: string },
  ctx?: SendCtx
): Promise<SendResult> {
  return dispatch(orgId, phone, { kind: "media", ...media }, ctx);
}

export function sendInteractive(
  orgId: string,
  phone: string,
  body: string,
  buttons: { id: string; title: string }[],
  ctx?: SendCtx
): Promise<SendResult> {
  return dispatch(orgId, phone, { kind: "interactive", body, buttons }, ctx);
}

export async function listTemplates(orgId: string): Promise<unknown[]> {
  const creds = await getCreds(orgId);
  if (!creds.wabaId) throw new ApiError(400, "WhatsApp Business Account ID not set");
  const json = await graphRead(creds, `/${creds.wabaId}/message_templates?limit=100`).catch((e: Error) => {
    throw new ApiError(502, `Could not load templates: ${e.message}`);
  });
  return (json.data as unknown[]) ?? [];
}

export interface TemplateDef {
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language?: string;
  components: unknown[];
}

export async function createTemplate(orgId: string, def: TemplateDef): Promise<unknown> {
  const creds = await getCreds(orgId);
  if (!creds.wabaId) throw new ApiError(400, "WhatsApp Business Account ID not set");
  return graphRead(creds, `/${creds.wabaId}/message_templates`, {
    method: "POST",
    body: { name: def.name, category: def.category, language: def.language ?? "en", components: def.components },
  }).catch((e: Error) => {
    throw new ApiError(502, `Template creation failed: ${e.message}`);
  });
}

// ───────────── Webhook helpers (see ./webhook.ts) ─────────────

/** Set wa_opt_out for a contact by phone. Returns the contact id if found. */
export async function handleOptOut(orgId: string, phone: string): Promise<string | null> {
  const c = await prisma.contacts.findFirst({ where: { org_id: orgId, phone } });
  if (!c) return null;
  // tenant-ok: contact found by org_id just above
  await prisma.contacts.update({ where: { id: c.id }, data: { wa_opt_out: true } });
  return c.id;
}
