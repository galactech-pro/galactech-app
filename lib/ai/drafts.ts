import { prisma, type Prisma, type channel } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { assertCanContact, safeContact, type ComplianceCode } from "@/lib/compliance";
import { PlanLimitError } from "@/lib/limits";
import { applyMergeTags } from "@/lib/utils";
import { sendMessage } from "@/lib/whatsapp";
import { renderSimple, sendEmail } from "@/lib/email";
import { describeClaim, findInvalidPlaceholders, findUngroundedClaims } from "./guards";
import { groundingStrings, type GroundingFacts } from "./index";

export type DraftOrigin = "automation" | "workflow" | "inbox" | "campaign" | "voice_script";

export interface DraftContext {
  origin: DraftOrigin;
  facts?: GroundingFacts;
  warnings?: string[];
  dedupe_key?: string;
  note?: string;
}

/**
 * THE single swap point for the actual transmission of an approved / non-gated AI message.
 * Once agent C ships lib/channels/outbound `sendOutbound`, replace the body of this function with one call to it
 * (keep the signature). Compliance is checked by the callers (deliverDraft / routeAiOutbound), not here.
 */
async function sendText(orgId: string, contactId: string, ch: channel, subject: string | null, body: string, idempotencyKey: string, purpose: "marketing" | "service", automated: boolean): Promise<void> {
  const c = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId, is_active: true } });
  if (!c) throw new ApiError(404, "Contact not found");
  const text = applyMergeTags(body, c);
  if (ch === "whatsapp") {
    await sendMessage(orgId, c.phone, text, { contactId, idempotencyKey, purpose, automated });
  } else if (ch === "email") {
    if (!c.email) throw new ApiError(400, "Contact has no email address");
    const subj = applyMergeTags(subject || "Following up", c);
    const html = await renderSimple(subj, text.split(/\n+/).map((s) => s.trim()).filter(Boolean));
    await sendEmail(orgId, { to: c.email, subject: subj, html, contactId, idempotencyKey, purpose, automated });
  } else {
    throw new ApiError(400, `Sending drafts on ${ch} is not supported yet`);
  }
}

/** Deliver a draft after a human approved it (optionally edited). Throws ComplianceError / ApiError on refusal. */
export async function deliverDraft(
  draft: { id: string; org_id: string; contact_id: string; channel: channel; subject: string | null; body: string; context: unknown },
  edited?: { body?: string; subject?: string | null }
): Promise<void> {
  const ctx = (draft.context ?? {}) as Partial<DraftContext>;
  // A reply drafted for the inbox answers the contact's own message (service); everything else is marketing outreach.
  const purpose = ctx.origin === "inbox" ? "service" : "marketing";
  await assertCanContact(draft.org_id, draft.contact_id, draft.channel, { purpose, automated: false });
  // key = draft id: a retried / double-clicked approval can never deliver the same draft twice
  await sendText(draft.org_id, draft.contact_id, draft.channel, edited?.subject ?? draft.subject, edited?.body ?? draft.body, `draft:${draft.id}`, purpose, false);
}

/** Current warnings for a draft body: invalid placeholders and claims not in the stored grounding facts. */
export function draftWarnings(ctx: Partial<DraftContext> | null | undefined, body: string): string[] {
  const out: string[] = [];
  const bad = findInvalidPlaceholders(body);
  if (bad.length) out.push(`Invalid placeholders: ${bad.join(" ")}`);
  if (ctx?.facts) out.push(...findUngroundedClaims(body, groundingStrings(ctx.facts)).map((c) => `Not in the provided facts: ${describeClaim(c)}`));
  else out.push("No grounding facts were stored for this draft; review every number, price and link manually.");
  return out;
}

export async function createDraft(i: {
  orgId: string;
  contactId: string;
  channel: channel;
  subject?: string | null;
  body: string;
  context: DraftContext;
}): Promise<{ id: string; created: boolean }> {
  // idempotency: Inngest step retries must not create duplicate drafts
  if (i.context.dedupe_key) {
    const existing = await prisma.ai_drafts.findFirst({
      where: { org_id: i.orgId, contact_id: i.contactId, context: { path: ["dedupe_key"], equals: i.context.dedupe_key } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
  }
  const row = await prisma.ai_drafts.create({
    data: {
      org_id: i.orgId,
      contact_id: i.contactId,
      channel: i.channel,
      subject: i.subject ?? null,
      body: i.body,
      context: { ...i.context, warnings: draftWarnings(i.context, i.body) } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: row.id, created: true };
}

export interface RouteResult {
  ok: boolean;
  drafted?: boolean;
  draftId?: string;
  reason?: string;
  code?: ComplianceCode;
}

/**
 * Route an AI-GENERATED outbound message from an automated path (automation / workflow / campaign AI writer):
 *  - compliance gate first (skip + log, never fail)
 *  - org.ai_approval_required (default true) or `forceDraft` -> create a pending ai_drafts row for a human
 *  - otherwise send now.
 * Human-typed messages and templated (non-AI) messages must NOT go through here.
 */
export async function routeAiOutbound(i: {
  orgId: string;
  contactId: string;
  channel: channel;
  subject?: string | null;
  body: string;
  origin: DraftOrigin;
  facts?: GroundingFacts;
  dedupeKey?: string;
  /** Stable per workflow-run/step/contact key (automationKey(...) or similar). Required: used for the direct-send path. */
  idempotencyKey: string;
  forceDraft?: boolean;
}): Promise<RouteResult> {
  // forceDraft = a human will send it, so the org-level "automatic outreach" switch is not required (consent still is)
  const gate = await safeContact(i.orgId, i.contactId, i.channel, { purpose: "marketing", automated: !i.forceDraft });
  if (!gate.allowed) return { ok: false, reason: gate.message, code: gate.code };

  const org = await prisma.organisations.findUnique({ where: { id: i.orgId }, select: { ai_approval_required: true } });
  if (i.forceDraft || org?.ai_approval_required !== false) {
    const d = await createDraft({
      orgId: i.orgId,
      contactId: i.contactId,
      channel: i.channel,
      subject: i.subject,
      body: i.body,
      context: { origin: i.origin, facts: i.facts, dedupe_key: i.dedupeKey },
    });
    return { ok: true, drafted: true, draftId: d.id };
  }
  try {
    await sendText(i.orgId, i.contactId, i.channel, i.subject ?? null, i.body, i.idempotencyKey, "marketing", !i.forceDraft);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError || e instanceof PlanLimitError) return { ok: false, reason: e.message };
    throw e;
  }
}
