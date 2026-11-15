import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { PlanLimitError } from "@/lib/limits";
import { sendMessage } from "@/lib/whatsapp";
import { sendEmail, sendSystemEmail, renderSimple } from "@/lib/email";
import { applyMergeTags } from "@/lib/utils";
import { safeContact, type ComplianceCode, type Purpose } from "@/lib/compliance";

export interface Outcome {
  ok: boolean;
  reason?: string;
  limit?: boolean;
  /** Set when skipped by the compliance gate (expected skip, not a failure). */
  code?: ComplianceCode;
}

export interface ContactOpts {
  purpose?: Purpose;
  automated?: boolean;
}

/** Default for workflow/automation sends: the strictest gate (marketing + automated). */
const AUTO: Required<ContactOpts> = { purpose: "marketing", automated: true };

function toOutcome(e: unknown): Outcome {
  if (e instanceof PlanLimitError) return { ok: false, reason: e.message, limit: true };
  if (e instanceof ApiError) return { ok: false, reason: e.message };
  console.error("[inngest] send error", e);
  return { ok: false, reason: e instanceof Error ? e.message : "unknown error" };
}

/** Send a WhatsApp text to a contact if allowed. Never throws for expected skips (opt-out, limits, not connected). */
export async function waToContact(orgId: string, contactId: string, text: string, idempotencyKey: string, campaignId?: string, opts: ContactOpts = AUTO): Promise<Outcome> {
  const c = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId, is_active: true } });
  if (!c) return { ok: false, reason: "contact not found" };
  const gate = await safeContact(orgId, contactId, "whatsapp", { ...AUTO, ...opts });
  if (!gate.allowed) return { ok: false, reason: gate.message ?? "not allowed", code: gate.code };
  try {
    await sendMessage(orgId, c.phone, applyMergeTags(text, c), { contactId, campaignId, idempotencyKey, purpose: opts.purpose ?? AUTO.purpose, automated: opts.automated ?? AUTO.automated });
    return { ok: true };
  } catch (e) {
    return toOutcome(e);
  }
}

export function textToHtmlParagraphs(text: string): string[] {
  return text.split(/\n{2,}|\n/).map((s) => s.trim()).filter(Boolean);
}

export async function emailToContact(orgId: string, contactId: string, subject: string, body: string, idempotencyKey: string, campaignId?: string, opts: ContactOpts = AUTO): Promise<Outcome> {
  const c = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId, is_active: true } });
  if (!c) return { ok: false, reason: "contact not found" };
  if (!c.email) return { ok: false, reason: "no email" };
  const gate = await safeContact(orgId, contactId, "email", { ...AUTO, ...opts });
  if (!gate.allowed) return { ok: false, reason: gate.message ?? "not allowed", code: gate.code };
  try {
    const subj = applyMergeTags(subject, c);
    const html = await renderSimple(subj, textToHtmlParagraphs(applyMergeTags(body, c)));
    await sendEmail(orgId, { to: c.email, subject: subj, html, contactId, campaignId, idempotencyKey, purpose: opts.purpose ?? AUTO.purpose, automated: opts.automated ?? AUTO.automated });
    return { ok: true };
  } catch (e) {
    return toOutcome(e);
  }
}

export async function slackAlert(text: string): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function hasInboundSince(orgId: string, contactId: string, since: Date): Promise<boolean> {
  const n = await prisma.messages.count({
    where: { org_id: orgId, contact_id: contactId, direction: "inbound", created_at: { gt: since } },
  });
  return n > 0;
}

export async function addTag(orgId: string, contactId: string, tag: string): Promise<boolean> {
  const c = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId }, select: { tags: true } });
  if (!c || c.tags.includes(tag)) return false;
  await prisma.contacts.update({ where: { id: contactId, org_id: orgId }, data: { tags: { set: [...c.tags, tag] } } });
  return true;
}

export async function orgOwner(orgId: string) {
  return prisma.users.findFirst({
    where: { org_id: orgId, is_active: true, role: { in: ["owner", "admin"] } },
    orderBy: { created_at: "asc" },
    select: { id: true, email: true, full_name: true },
  });
}

/** Email the org owner a branded notice (platform key). Returns false if skipped/failed. */
export async function notifyOwnerEmail(orgId: string, subject: string, paragraphs: string[], cta?: { label: string; url: string }): Promise<boolean> {
  const owner = await orgOwner(orgId);
  if (!owner) return false;
  try {
    await sendSystemEmail(owner.email, subject, await renderSimple(subject, paragraphs, cta));
    return true;
  } catch (e) {
    console.error("[inngest] owner email failed", e);
    return false;
  }
}

/**
 * Org owners have no phone on their user row, so WhatsApp to the owner works only when they also exist as a contact
 * (matched by email) and WhatsApp is connected. Callers fall back to email.
 */
export async function notifyOwnerWhatsApp(orgId: string, text: string, idempotencyKey: string): Promise<boolean> {
  const owner = await orgOwner(orgId);
  if (!owner) return false;
  const c = await prisma.contacts.findFirst({ where: { org_id: orgId, email: owner.email, is_active: true } });
  if (!c) return false;
  return (await waToContact(orgId, c.id, text, idempotencyKey, undefined, { purpose: "transactional", automated: false })).ok;
}

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}
