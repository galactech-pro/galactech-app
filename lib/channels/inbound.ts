import { prisma, Prisma, type contacts, type messages } from "@/lib/db";
import { applyStopKeyword, isStopKeyword } from "@/lib/compliance";
import { claimWebhookEvent, markProcessed, releaseWebhookEvent } from "@/lib/webhook-dedup";
import { normalizePhone } from "@/lib/utils";
import { emitEvent } from "./events";
import { sendOutbound } from "./outbound";
import { ensureContactInbox, ensureConversation, isUniqueViolation } from "./inbox";
import { applyMessageStatus } from "./status";
import type { InboundEvent, InboxCtx } from "./types";

type Outcome = "inserted" | "duplicate" | "skipped";

const PHONE_CHANNELS = new Set(["whatsapp", "sms", "voice"]);

async function resolveContact(inbox: InboxCtx, ev: InboundEvent): Promise<{ contact: contacts; created: boolean } | null> {
  const orgId = inbox.org_id;
  const sourceId = ev.sourceId;
  if (!sourceId) return null;

  const link = await prisma.contact_inboxes.findUnique({ where: { inbox_id_source_id: { inbox_id: inbox.id, source_id: sourceId } }, select: { contact_id: true } });
  if (link) {
    const c = await prisma.contacts.findFirst({ where: { id: link.contact_id, org_id: orgId } });
    if (c) return { contact: c, created: false };
  }

  const phone = PHONE_CHANNELS.has(inbox.channel) ? normalizePhone(ev.contactPhone ?? sourceId) ?? (ev.contactPhone ?? sourceId) : null;
  const email = inbox.channel === "email" ? (ev.contactEmail ?? sourceId).toLowerCase() : null;
  let existing: contacts | null = null;
  if (phone) existing = await prisma.contacts.findFirst({ where: { org_id: orgId, phone } });
  else if (email) existing = await prisma.contacts.findFirst({ where: { org_id: orgId, email } });
  if (existing) return { contact: existing, created: false };

  // contacts.phone is still NOT NULL in the schema: channels without a phone get a namespaced placeholder
  // ("<channel>:<source_id>") until contacts.phone becomes nullable. Phone-based sending ignores such contacts.
  const data: Prisma.contactsUncheckedCreateInput = {
    org_id: orgId,
    phone: phone ?? `${inbox.channel}:${sourceId}`,
    email,
    full_name: ev.contactName?.slice(0, 200) || phone || email || sourceId,
    source: `${inbox.channel}_inbound`,
    tags: ["inbound"],
  };
  try {
    return { contact: await prisma.contacts.create({ data }), created: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const again = await prisma.contacts.findFirst({ where: { org_id: orgId, phone: data.phone } });
    if (!again) throw e;
    return { contact: again, created: false };
  }
}

async function ingestMessage(inbox: InboxCtx, ev: InboundEvent): Promise<Outcome> {
  const orgId = inbox.org_id;
  const resolved = await resolveContact(inbox, ev);
  if (!resolved) return "skipped";
  const { contact, created } = resolved;
  const text = ev.content ?? `[${ev.contentType ?? "message"}]`;
  const stop = (inbox.channel === "whatsapp" || inbox.channel === "sms") && isStopKeyword(text);

  if (!contact.is_active) {
    // Erased/soft-deleted contact (L-10): never re-attach or re-activate, but still honour STOP.
    // tenant-ok: contact resolved within the inbox org
    if (stop && !contact.wa_opt_out) await prisma.contacts.update({ where: { id: contact.id }, data: { wa_opt_out: true } });
    return "skipped";
  }

  await ensureContactInbox(contact.id, inbox.id, ev.sourceId as string);
  const conv = await ensureConversation(orgId, contact.id, inbox);
  const at = ev.sentAt ?? new Date();
  const atIso = at.toISOString(); // ISO text cast to timestamp: wall time stays UTC regardless of session TimeZone

  // Idempotent insert: @@unique([inbox_id, external_id]); a duplicate delivery hits P2002 and is ignored.
  let message: messages;
  try {
    message = await prisma.$transaction(async (tx) => {
      const m = await tx.messages.create({
        data: {
          org_id: orgId,
          contact_id: contact.id,
          channel: inbox.channel,
          direction: "inbound",
          content: text,
          status: "delivered",
          inbox_id: inbox.id,
          conversation_id: conv.id,
          external_id: ev.externalId,
          wa_message_id: inbox.channel === "whatsapp" ? ev.externalId : null,
          sent_at: at,
        },
      });
      // atomic, monotonic conversation update (a late-processed older message must not move times backwards)
      await tx.$executeRaw`
        UPDATE conversations SET
          last_inbound_at = GREATEST(COALESCE(last_inbound_at, 'epoch'::timestamp), ${atIso}::timestamp),
          last_message_at = GREATEST(last_message_at, ${atIso}::timestamp),
          unread_count = unread_count + 1,
          status = CASE WHEN status IN ('resolved'::conversation_status, 'snoozed'::conversation_status) THEN 'open'::conversation_status ELSE status END
        WHERE id = ${conv.id}::uuid`;
      return m;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // a retried delivery whose first attempt may have died before the STOP flag was written
      // tenant-ok: contact resolved within the inbox org
      if (stop && !contact.wa_opt_out) await prisma.contacts.update({ where: { id: contact.id }, data: { wa_opt_out: true } });
      return "duplicate";
    }
    throw e;
  }

  // Everything below runs only for newly inserted rows.
  const lastOut = await prisma.messages.findFirst({
    where: { org_id: orgId, contact_id: contact.id, direction: "outbound", replied_at: null, channel: inbox.channel },
    orderBy: { created_at: "desc" },
    select: { id: true },
  });
  // tenant-ok: message id returned by an org-scoped query
  if (lastOut) await prisma.messages.update({ where: { id: lastOut.id }, data: { replied_at: new Date() } }).catch(() => undefined);
  // tenant-ok: contact resolved within the inbox org
  await prisma.contacts.update({ where: { id: contact.id }, data: { last_contacted_at: new Date() } }).catch(() => undefined);

  if (created) await emitEvent("contact/created", { org_id: orgId, contact_id: contact.id }, `contact-created-${contact.id}`);

  if (stop) {
    // Confirmation first (service purpose, inside the window): once the opt-out flags are set the compliance gate blocks everything.
    try {
      await sendOutbound({
        orgId,
        contactId: contact.id,
        channel: inbox.channel,
        inboxId: inbox.id,
        content: { kind: "text", text: process.env.STOP_CONFIRMATION_TEXT || "You have been unsubscribed and will not receive further messages from us." },
        purpose: "service",
        idempotencyKey: `stop-confirm:${message.id}`,
      });
    } catch (e) {
      console.warn("[inbound] STOP confirmation not sent", e instanceof Error ? e.message : e);
    }
    await applyStopKeyword(orgId, contact.id, inbox.channel, text);
    return "inserted"; // opted out: no reply automations
  }


  await emitEvent("message/inbound", { org_id: orgId, contact_id: contact.id, message_id: message.id }, `message-inbound-${message.id}`);
  return "inserted";
}

async function ingestStatus(inbox: InboxCtx, ev: InboundEvent): Promise<Outcome> {
  if (!ev.status) return "skipped";
  const changed = await applyMessageStatus(inbox.org_id, ev.externalId, ev.status, { error: ev.error ?? ev.errorCode, at: ev.sentAt });
  return changed ? "inserted" : "skipped";
}

/**
 * Shared inbound pipeline for ANY channel adapter. `inbox` is already resolved from (channel, identifier), so the
 * org is trusted only through the inbox row. Each event is claimed in webhook_events (provider-level dedup) and
 * processed idempotently; a failed event is released so the provider's retry is accepted.
 * Returns the number of failures (route should answer 500 so the provider retries when > 0).
 */
export async function processInboundEvents(inbox: InboxCtx, events: InboundEvent[]): Promise<{ inserted: number; duplicates: number; failed: number }> {
  const stats = { inserted: 0, duplicates: 0, failed: 0 };
  for (const ev of events) {
    const eventId = ev.kind === "status" ? `status:${ev.externalId}:${ev.status ?? ""}` : `msg:${inbox.id}:${ev.externalId}`;
    try {
      const claimed = await claimWebhookEvent(inbox.provider, eventId, inbox.org_id);
      if (!claimed) {
        stats.duplicates++;
        continue;
      }
      try {
        const r = ev.kind === "status" ? await ingestStatus(inbox, ev) : await ingestMessage(inbox, ev);
        if (r === "duplicate") stats.duplicates++;
        else if (r === "inserted") stats.inserted++;
        await markProcessed(inbox.provider, eventId);
      } catch (e) {
        await releaseWebhookEvent(inbox.provider, eventId).catch(() => undefined);
        throw e;
      }
    } catch (e) {
      stats.failed++;
      console.error(`[inbound] ${inbox.channel} ${ev.kind} ${ev.externalId} failed`, e);
    }
  }
  return stats;
}
