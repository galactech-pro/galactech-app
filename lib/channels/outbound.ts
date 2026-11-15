import { prisma, type channel, type messages } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { assertCanContact, type Purpose } from "@/lib/compliance";
import { releaseUsage, reserveUsage } from "./usage";
import { ensureContactInbox, ensureConversation, isUniqueViolation, lastInboundAt, resolveOutboundInbox } from "./inbox";
import { findAdapter } from "./registry";
import { ChannelError, OutboundError, type OutboundContent } from "./types";

export interface SendOutboundInput {
  orgId: string;
  contactId: string;
  channel: channel;
  /** Defaults to the org's default inbox for the channel (legacy orgs get one created lazily). */
  inboxId?: string;
  content: OutboundContent;
  /** marketing needs consent; service/transactional only block on hard opt-outs/DNC (see lib/compliance). */
  purpose: Purpose;
  automated?: boolean;
  campaignId?: string | null;
  /**
   * Derived from the business operation, NOT random, so retries collapse onto the same outbox row:
   * campaign -> campaignKey(campaignId, contactId); automation -> automationKey(runId, stepId, contactId).
   * Interactive replies may use a random per-request key.
   */
  idempotencyKey: string;
}

export interface OutboundResult {
  message: messages;
  /** sent: provider accepted. unknown: ambiguous provider failure, message stays queued/UNKNOWN (reconcile decides, never auto-resent).
   *  duplicate: an outbox row with this key already existed; nothing was sent now. */
  state: "sent" | "unknown" | "duplicate";
}

export const campaignKey = (campaignId: string, contactId: string) => `campaign:${campaignId}:${contactId}`;
export const automationKey = (runId: string, stepId: string, contactId: string) => `automation:${runId}:${stepId}:${contactId}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RATE_LIMIT_RETRIES = 2;

export function summarizeContent(c: OutboundContent): string {
  switch (c.kind) {
    case "text":
      return c.text;
    case "template":
      return `[template:${c.name}] ${(c.params ?? []).join(" | ")}`.trim();
    case "media":
      return `[${c.type}] ${c.caption ?? c.url}`;
    case "interactive":
      return c.body;
    case "email":
      return `${c.subject}\n\n${(c.text ?? c.html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 4000)}`;
    case "voice_call":
      return `[AI call] ${(c.script ?? "").slice(0, 200)}`.trim();
  }
}

async function withDbRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(150 * (i + 1));
    }
  }
  throw last;
}

function addressFor(ch: channel, contact: { phone: string; email: string | null }): string | null {
  if (ch === "whatsapp" || ch === "sms" || ch === "voice") return contact.phone || null;
  if (ch === "email") return contact.email;
  return null;
}

/**
 * THE outbound pipeline. Every send (inbox reply, campaign, automation, workflow, voice call) goes through here:
 *  1. idempotency lookup  -> an existing outbox row is returned, never re-sent
 *  2. assertCanContact    -> ComplianceError propagates (nothing recorded)
 *  3. outbox INSERT (status queued, unique key) BEFORE touching the provider
 *  4. session-window / template rule (adapter.sessionWindow) -> row marked failed + OutboundError
 *  5. atomic usage reservation (PlanLimitError -> outbox row removed so a later resume can retry)
 *  6. adapter.send (single attempt; only HTTP-429-style "not accepted" errors are retried)
 *  7. sent / failed(definitive, usage released) / unknown(ambiguous: stays queued with error "UNKNOWN")
 */
export async function sendOutbound(input: SendOutboundInput): Promise<OutboundResult> {
  const { orgId, contactId, content } = input;
  const key = `${orgId}:${input.idempotencyKey}`; // namespaced per org

  // tenant-ok: idempotency_key is org-namespaced (org_id:key)
  const existing = await prisma.messages.findUnique({ where: { idempotency_key: key } });
  if (existing) return { message: existing, state: "duplicate" };

  const inbox = await resolveOutboundInbox(orgId, input.channel, input.inboxId);
  const adapter = findAdapter(inbox.channel, inbox.provider);
  const caps = adapter?.capabilities(inbox);
  if (!adapter || !caps?.supportsOutbound) throw new OutboundError("CHANNEL_NOT_SUPPORTED", `Sending on ${input.channel} is not supported yet`);

  await assertCanContact(orgId, contactId, input.channel, { purpose: input.purpose, automated: input.automated });

  const contact = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId }, select: { phone: true, email: true } });
  if (!contact) throw new OutboundError("NO_ADDRESS", "Contact not found");
  let to = addressFor(input.channel, contact);
  if (!to) {
    const ci = await prisma.contact_inboxes.findFirst({ where: { contact_id: contactId, inbox_id: inbox.id }, select: { source_id: true } });
    to = ci?.source_id ?? null;
  }
  if (!to) throw new OutboundError("NO_ADDRESS", `Contact has no ${input.channel} address`);

  await ensureContactInbox(contactId, inbox.id, to);
  const conv = await ensureConversation(orgId, contactId, inbox);

  // (3) outbox row first
  let row: messages;
  try {
    row = await prisma.messages.create({
      data: {
        org_id: orgId,
        contact_id: contactId,
        campaign_id: input.campaignId ?? null,
        channel: input.channel,
        direction: "outbound",
        content: summarizeContent(content),
        status: "queued",
        inbox_id: inbox.id,
        conversation_id: conv.id,
        idempotency_key: key,
      },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // tenant-ok: idempotency_key is org-namespaced (org_id:key)
    const dup = await prisma.messages.findUnique({ where: { idempotency_key: key } });
    if (dup) return { message: dup, state: "duplicate" };
    throw e;
  }

  const fail = async (error: string) => {
    await prisma.messages.updateMany({ where: { id: row.id, status: "queued" }, data: { status: "failed", error: error.slice(0, 500) } });
  };

  // (4) session window: outside it only templates may be sent (applies to campaigns, automations and replies alike)
  if (caps.hasSessionWindow && content.kind !== "template") {
    const last = await lastInboundAt(orgId, conv, input.channel);
    const w = adapter.sessionWindow({ last_inbound_at: last });
    if (w.state === "closed" && w.outsideWindowRule !== "none") {
      const msg = "The 24-hour customer-service window is closed for this contact. Send an approved message template instead.";
      await fail(`SESSION_WINDOW_EXPIRED: ${msg}`);
      throw new OutboundError("SESSION_WINDOW_EXPIRED", msg, row.id);
    }
  }

  // (5) atomic reservation
  const metric = caps.usageMetric;
  if (metric) {
    try {
      await reserveUsage(orgId, metric, 1);
    } catch (e) {
      await prisma.messages.deleteMany({ where: { id: row.id, status: "queued" } });
      throw e;
    }
  }

  // (6) single provider attempt
  let externalId = "";
  let attempt = 0;
  for (;;) {
    try {
      const r = await adapter.send(inbox, { to, content, messageId: row.id, idempotencyKey: key, orgId, contactId, campaignId: input.campaignId });
      externalId = r.externalId;
      break;
    } catch (e) {
      const ce = e instanceof ChannelError ? e : null;
      const mayRetry = ce && attempt < MAX_RATE_LIMIT_RETRIES && (ce.retryable || (ce.ambiguous && caps.idempotentSend));
      if (mayRetry) {
        attempt++;
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (!ce && !isDefinitiveNonChannel(e)) {
        // unknown exception: we cannot tell whether the provider saw the request -> ambiguous
        console.error("[outbound] unexpected error during send", e);
        await prisma.messages.updateMany({ where: { id: row.id, status: "queued" }, data: { error: "UNKNOWN" } });
        // tenant-ok: row id created in this call for this org
        return { message: (await prisma.messages.findUnique({ where: { id: row.id } })) ?? row, state: "unknown" };
      }
      if (ce?.ambiguous) {
        console.warn(`[outbound] ambiguous provider failure for message ${row.id}: ${ce.message}`);
        await prisma.messages.updateMany({ where: { id: row.id, status: "queued" }, data: { error: "UNKNOWN" } });
        // tenant-ok: row id created in this call for this org
        return { message: (await prisma.messages.findUnique({ where: { id: row.id } })) ?? row, state: "unknown" };
      }
      // definitive failure: provider did not accept it
      const text = e instanceof Error ? e.message : "send failed";
      await fail(ce ? `${ce.code}: ${text}` : text);
      if (metric) await releaseUsage(orgId, metric, 1).catch((er) => console.error("[outbound] release failed", er));
      if (!ce) throw e; // ApiError (e.g. "not configured") keeps its own status/message
      throw new OutboundError("PROVIDER_REJECTED", text, row.id);
    }
  }

  // (7) success bookkeeping must never throw after a successful send
  const sentAt = new Date();
  const mirror = input.channel === "whatsapp" || input.channel === "email" ? externalId || undefined : undefined; // legacy wa_message_id
  try {
    await withDbRetry(async () => {
      try {
        await prisma.messages.updateMany({
          where: { id: row.id, status: "queued" },
          data: { status: "sent", sent_at: sentAt, error: null, external_id: externalId || undefined, wa_message_id: mirror },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        await prisma.messages.updateMany({ where: { id: row.id, status: "queued" }, data: { status: "sent", sent_at: sentAt, error: null, wa_message_id: mirror } });
      }
    });
  } catch (e) {
    console.error(`[outbound] message ${row.id} was SENT (external ${externalId}) but the status update failed`, e);
  }
  // tenant-ok: contact verified for this org by assertCanContact
  await prisma.contacts.update({ where: { id: contactId }, data: { last_contacted_at: sentAt } }).catch(() => undefined);
  await prisma.conversations.updateMany({ where: { id: conv.id }, data: { last_message_at: sentAt } }).catch(() => undefined);

  // tenant-ok: row id created in this call for this org
  const message = (await prisma.messages.findUnique({ where: { id: row.id } })) ?? row;
  return { message, state: "sent" };
}

/** Errors thrown by our own pre-flight code (before any provider request) are definitive, not ambiguous. */
function isDefinitiveNonChannel(e: unknown): boolean {
  return e instanceof ApiError;
}
