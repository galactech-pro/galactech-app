import { randomBytes } from "node:crypto";
import { prisma, Prisma, type channel, type conversations, type inboxes } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { ApiError } from "@/lib/api";
import type { InboxCtx } from "./types";

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
export { isUniqueViolation };

export function toInboxCtx(row: inboxes): InboxCtx {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(decrypt(row.config)) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Channel credentials are invalid. Please reconnect the channel.");
  }
  return {
    id: row.id,
    org_id: row.org_id,
    channel: row.channel,
    provider: row.provider,
    identifier: row.identifier,
    name: row.name,
    is_active: row.is_active,
    config,
  };
}

export async function loadInbox(orgId: string, inboxId: string): Promise<InboxCtx> {
  const row = await prisma.inboxes.findFirst({ where: { id: inboxId, org_id: orgId } });
  if (!row) throw new ApiError(404, "Inbox not found");
  if (!row.is_active) throw new ApiError(400, "This inbox is disabled");
  return toInboxCtx(row);
}

const newToken = () => randomBytes(24).toString("hex");

async function createInbox(orgId: string, data: { channel: channel; provider: string; name: string; identifier: string; config: Record<string, unknown> }) {
  try {
    return await prisma.inboxes.create({
      data: { org_id: orgId, channel: data.channel, provider: data.provider, name: data.name, identifier: data.identifier, config: encrypt(JSON.stringify(data.config)), webhook_token: newToken() },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await prisma.inboxes.findFirst({ where: { channel: data.channel, identifier: data.identifier } });
    if (!row || row.org_id !== orgId) throw new ApiError(409, "This channel identifier is already connected to another organisation");
    return row;
  }
}

/**
 * WhatsApp inbox for legacy orgs: created lazily from organisations.wa_phone_number_id. The token is NOT copied
 * (config {source:"org"}); the adapter keeps reading the org row, so settings changes stay effective.
 * If the org changed its phone_number_id, the org-sourced inbox identifier follows it.
 */
export async function ensureWhatsappInbox(orgId: string): Promise<InboxCtx> {
  const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { wa_phone_number_id: true, wa_access_token: true } });
  const existing = await prisma.inboxes.findFirst({ where: { org_id: orgId, channel: "whatsapp", provider: "whatsapp_cloud", is_active: true }, orderBy: { created_at: "asc" } });
  if (org?.wa_phone_number_id && org.wa_access_token) {
    const byId = await prisma.inboxes.findFirst({ where: { channel: "whatsapp", identifier: org.wa_phone_number_id } });
    if (byId) {
      if (byId.org_id !== orgId) throw new ApiError(409, "This WhatsApp number is connected to another organisation");
      return toInboxCtx(byId);
    }
    if (existing && toInboxCtx(existing).config.source === "org") {
      // tenant-ok: inbox row loaded by org_id just above
      return toInboxCtx(await prisma.inboxes.update({ where: { id: existing.id }, data: { identifier: org.wa_phone_number_id } }));
    }
    return toInboxCtx(
      await createInbox(orgId, { channel: "whatsapp", provider: "whatsapp_cloud", name: "WhatsApp", identifier: org.wa_phone_number_id, config: { source: "org" } })
    );
  }
  if (existing) return toInboxCtx(existing);
  throw new ApiError(400, "WhatsApp not connected");
}

/** Email works with the platform Resend key even when the org has none, so this always succeeds. */
export async function ensureEmailInbox(orgId: string): Promise<InboxCtx> {
  const row = await prisma.inboxes.findFirst({ where: { org_id: orgId, channel: "email", provider: "resend", is_active: true }, orderBy: { created_at: "asc" } });
  if (row) return toInboxCtx(row);
  return toInboxCtx(await createInbox(orgId, { channel: "email", provider: "resend", name: "Email", identifier: `resend:${orgId}`, config: { source: "org" } }));
}

export async function ensureVoiceInbox(orgId: string): Promise<InboxCtx> {
  const row = await prisma.inboxes.findFirst({ where: { org_id: orgId, channel: "voice", provider: "vapi", is_active: true }, orderBy: { created_at: "asc" } });
  if (row) return toInboxCtx(row);
  return toInboxCtx(await createInbox(orgId, { channel: "voice", provider: "vapi", name: "AI calls", identifier: `vapi:${orgId}`, config: { source: "env" } }));
}

/** Resolve the inbox an outbound message should use. Explicit inboxId wins; otherwise the org's default for the channel. */
export async function resolveOutboundInbox(orgId: string, ch: channel, inboxId?: string): Promise<InboxCtx> {
  if (inboxId) {
    const ib = await loadInbox(orgId, inboxId);
    if (ib.channel !== ch) throw new ApiError(422, "Inbox does not belong to this channel");
    return ib;
  }
  if (ch === "whatsapp") return ensureWhatsappInbox(orgId);
  if (ch === "email") return ensureEmailInbox(orgId);
  if (ch === "voice") return ensureVoiceInbox(orgId);
  const row = await prisma.inboxes.findFirst({ where: { org_id: orgId, channel: ch, is_active: true }, orderBy: { created_at: "asc" } });
  if (!row) throw new ApiError(400, `${ch} is not connected`);
  return toInboxCtx(row);
}

/**
 * Inbound routing: (channel, identifier) -> inbox. The org is ALWAYS taken from the inbox row, never from the payload.
 * Legacy WhatsApp orgs (no inbox yet) are matched through organisations.wa_phone_number_id (unique) and get their
 * inbox created lazily.
 */
export async function resolveInboxByIdentifier(ch: channel, identifier: string): Promise<InboxCtx | null> {
  if (!identifier) return null;
  // tenant-ok: inbox routing by globally unique (channel, identifier); the org is taken FROM this row
  const row = await prisma.inboxes.findUnique({ where: { channel_identifier: { channel: ch, identifier } } });
  if (row) return row.is_active ? toInboxCtx(row) : null;
  if (ch === "whatsapp") {
    const org = await prisma.organisations.findUnique({ where: { wa_phone_number_id: identifier }, select: { id: true } });
    if (org) return ensureWhatsappInbox(org.id).catch(() => null);
  }
  return null;
}

export async function ensureContactInbox(contactId: string, inboxId: string, sourceId: string): Promise<void> {
  const existing = await prisma.contact_inboxes.findFirst({ where: { OR: [{ inbox_id: inboxId, source_id: sourceId }, { contact_id: contactId, inbox_id: inboxId }] }, select: { id: true } });
  if (existing) return;
  try {
    await prisma.contact_inboxes.create({ data: { contact_id: contactId, inbox_id: inboxId, source_id: sourceId } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

/**
 * One conversation per (contact, inbox) — Chatwoot's "lock to single conversation". There is no DB unique for it, so
 * creation is serialised with a transaction-scoped advisory lock. When a conversation is created for a contact with
 * legacy messages, last_inbound_at is backfilled from them (needed for the WhatsApp window).
 */
export async function ensureConversation(orgId: string, contactId: string, inbox: Pick<InboxCtx, "id" | "channel">): Promise<conversations> {
  const found = await prisma.conversations.findFirst({ where: { org_id: orgId, contact_id: contactId, inbox_id: inbox.id }, orderBy: { created_at: "asc" } });
  if (found) return found;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`conv:${inbox.id}:${contactId}`}))`;
    const again = await tx.conversations.findFirst({ where: { org_id: orgId, contact_id: contactId, inbox_id: inbox.id }, orderBy: { created_at: "asc" } });
    if (again) return again;
    const lastIn = await tx.messages.findFirst({ where: { org_id: orgId, contact_id: contactId, channel: inbox.channel, direction: "inbound" }, orderBy: { created_at: "desc" }, select: { created_at: true } });
    const lastAny = await tx.messages.findFirst({ where: { org_id: orgId, contact_id: contactId, channel: inbox.channel }, orderBy: { created_at: "desc" }, select: { created_at: true } });
    return tx.conversations.create({
      data: { org_id: orgId, contact_id: contactId, inbox_id: inbox.id, last_inbound_at: lastIn?.created_at ?? null, last_message_at: lastAny?.created_at ?? new Date() },
    });
  });
}

/** last inbound time for window checks; falls back to legacy un-linked messages when the conversation has none. */
export async function lastInboundAt(orgId: string, conv: Pick<conversations, "last_inbound_at" | "contact_id">, ch: channel): Promise<Date | null> {
  if (conv.last_inbound_at) return conv.last_inbound_at;
  const m = await prisma.messages.findFirst({ where: { org_id: orgId, contact_id: conv.contact_id, channel: ch, direction: "inbound" }, orderBy: { created_at: "desc" }, select: { created_at: true } });
  return m?.created_at ?? null;
}
