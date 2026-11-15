import { prisma, type channel, type conversations } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ensureConversation, lastInboundAt, resolveOutboundInbox, toInboxCtx } from "./inbox";
import { findAdapter } from "./registry";
import type { InboxCtx } from "./types";

const LEGACY_CHANNELS = new Set<channel>(["whatsapp", "email", "voice"]);
const backfilled = new Map<string, number>(); // orgId -> expiry (ms): skip re-scanning for a while
const BACKFILL_TTL_MS = 10 * 60_000;

/**
 * Backfill-on-read: messages written before the inbox/conversation tables (conversation_id IS NULL) are attached to a
 * lazily created inbox + conversation per (contact, channel). Bounded per call (200 pairs) and memoised per org.
 * Every message written by the current pipeline already has a conversation, so this converges to a no-op.
 */
export async function backfillLegacyConversations(orgId: string): Promise<void> {
  const until = backfilled.get(orgId);
  if (until && until > Date.now()) return;
  const pairs = await prisma.$queryRaw<{ contact_id: string; channel: channel }[]>`
    SELECT DISTINCT contact_id, channel FROM messages WHERE org_id = ${orgId}::uuid AND conversation_id IS NULL LIMIT 200`;
  const inboxes = new Map<channel, InboxCtx | null>();
  for (const p of pairs) {
    if (!LEGACY_CHANNELS.has(p.channel)) continue; // no inbox can be derived without provider config (sms etc.)
    if (!inboxes.has(p.channel)) inboxes.set(p.channel, await resolveOutboundInbox(orgId, p.channel).catch(() => null));
    const inbox = inboxes.get(p.channel);
    if (!inbox) continue;
    try {
      const existed = await prisma.conversations.findFirst({ where: { org_id: orgId, contact_id: p.contact_id, inbox_id: inbox.id }, select: { id: true } });
      const conv = await ensureConversation(orgId, p.contact_id, inbox);
      await prisma.messages.updateMany({ where: { org_id: orgId, contact_id: p.contact_id, channel: p.channel, conversation_id: null }, data: { conversation_id: conv.id, inbox_id: inbox.id } });
      const [lastAny, lastIn, lastOut] = await Promise.all([
        prisma.messages.findFirst({ where: { conversation_id: conv.id }, orderBy: { created_at: "desc" }, select: { created_at: true } }),
        prisma.messages.findFirst({ where: { conversation_id: conv.id, direction: "inbound" }, orderBy: { created_at: "desc" }, select: { created_at: true } }),
        prisma.messages.findFirst({ where: { conversation_id: conv.id, direction: "outbound" }, orderBy: { created_at: "desc" }, select: { created_at: true } }),
      ]);
      const data: { last_message_at?: Date; last_inbound_at?: Date; unread_count?: number } = {};
      if (lastAny) data.last_message_at = lastAny.created_at;
      if (lastIn) data.last_inbound_at = lastIn.created_at;
      if (!existed) {
        // unread = inbound after our last outbound (the old inbox's definition)
        data.unread_count = await prisma.messages.count({ where: { conversation_id: conv.id, direction: "inbound", created_at: { gt: lastOut?.created_at ?? new Date(0) } } });
      }
      // tenant-ok: conv created/loaded for this org
      await prisma.conversations.update({ where: { id: conv.id }, data });
    } catch (e) {
      console.error("[inbox] legacy backfill failed", p, e);
    }
  }
  if (pairs.length < 200) backfilled.set(orgId, Date.now() + BACKFILL_TTL_MS);
}

/** Most recent conversation of a contact, creating one lazily (channel from the latest message, else whatsapp, else email). */
export async function conversationForContact(orgId: string, contactId: string): Promise<conversations> {
  await backfillLegacyConversations(orgId);
  const found = await prisma.conversations.findFirst({ where: { org_id: orgId, contact_id: contactId }, orderBy: { last_message_at: "desc" } });
  if (found) return found;
  const contact = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId, is_active: true }, select: { id: true, email: true } });
  if (!contact) throw new ApiError(404, "Contact not found");
  const latest = await prisma.messages.findFirst({ where: { org_id: orgId, contact_id: contactId }, orderBy: { created_at: "desc" }, select: { channel: true } });
  const order: channel[] = [...(latest ? [latest.channel] : []), "whatsapp", ...(contact.email ? (["email"] as channel[]) : [])];
  for (const ch of order) {
    const inbox = await resolveOutboundInbox(orgId, ch).catch(() => null);
    if (inbox) return ensureConversation(orgId, contactId, inbox);
  }
  throw new ApiError(400, "No messaging channel is connected for this contact");
}

export interface ThreadQuery {
  limit: number;
  before?: Date;
}

/** Conversation thread (oldest -> newest) with the channel's session-window state. All queries are org-scoped. */
export async function loadThread(orgId: string, conversationId: string, q: ThreadQuery) {
  const conv = await prisma.conversations.findFirst({
    where: { id: conversationId, org_id: orgId },
    include: { inbox: true, contact: { include: { assignee: { select: { id: true, full_name: true } } } } },
  });
  if (!conv || !conv.contact.is_active) throw new ApiError(404, "Conversation not found");

  const rows = await prisma.messages.findMany({
    where: { org_id: orgId, conversation_id: conv.id, ...(q.before ? { created_at: { lt: q.before } } : {}) },
    orderBy: { created_at: "desc" },
    take: q.limit,
  });

  const inbox = toInboxCtxSafe(conv.inbox);
  const adapter = findAdapter(conv.inbox.channel, conv.inbox.provider);
  const caps = adapter?.capabilities(inbox ?? undefined);
  const last = await lastInboundAt(orgId, conv, conv.inbox.channel);
  const w = adapter?.sessionWindow({ last_inbound_at: last });
  const { inbox: ib, contact, ...conversation } = conv;
  return {
    conversation: { ...conversation, assignee_id: conv.assignee_id },
    contact,
    inbox: { id: ib.id, channel: ib.channel, name: ib.name, provider: ib.provider },
    messages: rows.reverse(),
    has_more: rows.length === q.limit,
    session_window: {
      applies: !!caps?.hasSessionWindow,
      open: !caps?.hasSessionWindow || w?.state !== "closed",
      expires_at: w?.closesAt ?? null,
      rule: w?.outsideWindowRule ?? "none",
    },
    can_reply: !!caps?.supportsOutbound && ib.channel !== "voice",
  };
}

function toInboxCtxSafe(row: Parameters<typeof toInboxCtx>[0]): InboxCtx | null {
  try {
    return toInboxCtx(row);
  } catch {
    return null;
  }
}
