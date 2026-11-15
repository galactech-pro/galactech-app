import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { ApiError } from "@/lib/api";
import type { Purpose } from "@/lib/compliance";
import { campaignKey, sendOutbound } from "@/lib/channels/outbound";
import { toApiError } from "@/lib/channels/errors";
import { buildTransactional, renderShell, type TransactionalKind } from "./templates";
import { fromAddress } from "./tokens";

export { renderSimple } from "./templates";
export { unsubscribeToken, verifyUnsubscribeToken, trackingToken, verifyTrackingToken, clickSignature, verifyClickSignature } from "./tokens";

// ───────────── Platform (transactional/system) sender - not part of the contact outbound pipeline ─────────────
async function getResend(orgId: string | null): Promise<Resend> {
  let key: string | undefined;
  if (orgId) {
    const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { resend_api_key: true } });
    if (org?.resend_api_key) {
      try {
        key = decrypt(org.resend_api_key);
      } catch {
        key = undefined;
      }
    }
  }
  key = key || process.env.RESEND_API_KEY;
  if (!key) throw new ApiError(400, "Email is not configured (no Resend API key)");
  return new Resend(key);
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  contactId?: string;
  campaignId?: string;
  /** Default: "marketing" for campaign sends, otherwise "service". */
  purpose?: Purpose;
  automated?: boolean;
  /** Stable key for the business operation (see lib/channels/outbound.ts). Random when omitted (no retry protection). */
  idempotencyKey?: string;
}

/**
 * Contact email through the shared outbound pipeline (compliance, atomic limits, outbox row, idempotent provider call).
 * A matching contact is required: the unsubscribe link and tracking are bound to it (L-05).
 */
export async function sendEmail(orgId: string, input: SendEmailInput): Promise<{ messageId: string }> {
  const contact = input.contactId
    ? await prisma.contacts.findFirst({ where: { id: input.contactId, org_id: orgId }, select: { id: true } })
    : await prisma.contacts.findFirst({ where: { org_id: orgId, email: input.to, is_active: true }, select: { id: true } });
  if (!contact) throw new ApiError(404, "Contact not found");
  try {
    const r = await sendOutbound({
      orgId,
      contactId: contact.id,
      channel: "email",
      content: { kind: "email", subject: input.subject, html: input.html },
      purpose: input.purpose ?? (input.campaignId ? "marketing" : "service"),
      automated: input.automated,
      campaignId: input.campaignId,
      idempotencyKey: input.idempotencyKey ?? (input.campaignId ? campaignKey(input.campaignId, contact.id) : randomUUID()),
    });
    return { messageId: r.message.id };
  } catch (e) {
    throw toApiError(e, "Email send");
  }
}

/** System emails (not tied to an org's quota or contacts): uses platform RESEND_API_KEY. */
export async function sendTransactional(
  kind: TransactionalKind,
  to: string,
  data: Record<string, unknown> = {}
): Promise<{ messageId: string }> {
  const resend = await getResend(null);
  const { subject, shell } = buildTransactional(kind, data);
  const html = await renderShell(shell);
  const { data: res, error } = await resend.emails.send({ from: fromAddress(), to, subject, html });
  if (error) throw new ApiError(502, `Email send failed: ${error.message}`);
  return { messageId: res?.id ?? "" };
}

/** Internal notification email (alerts, reports) via the platform key. Not logged, not counted against org quota. */
export async function sendSystemEmail(to: string, subject: string, html: string): Promise<{ messageId: string }> {
  const resend = await getResend(null);
  const { data, error } = await resend.emails.send({ from: fromAddress(), to, subject, html });
  if (error) throw new ApiError(502, `Email send failed: ${error.message}`);
  return { messageId: data?.id ?? "" };
}
