import { ChannelError, type ChannelAdapter, type InboundEvent } from "../types";
import { NO_WINDOW, assertNotOptedOut, textOf } from "./_shared";

/**
 * Web chat widget channel (public/webchat.js). There is no external provider: an agent reply is stored by the
 * outbound pipeline as an outbound message row and the widget fetches it from the poll endpoint, so send() makes no
 * network call and cannot fail ambiguously. Visitors are identified by a random id stored in the visitor's
 * localStorage (contact_inboxes.source_id); anyone holding that id can read that visitor's thread (128-bit random,
 * documented in docs/CHANNELS.md). No delivery receipts: messages are "sent" once stored.
 */
export const WEBCHAT_MAX_TEXT = 2000;
export const VISITOR_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const webchatAdapter: ChannelAdapter = {
  channel: "webchat",
  provider: "webchat",
  capabilities: () => ({
    supportsText: true,
    supportsTemplates: false,
    supportsMedia: false,
    supportsButtons: false,
    supportsOutbound: true,
    supportsInbound: true,
    hasSessionWindow: false,
    idempotentSend: true, // local DB write only; the outbox idempotency key already guards duplicates
    usageMetric: null,
    maxTextLength: WEBCHAT_MAX_TEXT,
  }),
  sessionWindow: () => ({ ...NO_WINDOW }),
  /** Auth is the unguessable per-inbox webhook token (resolved by the route) + the per-inbox origin allow-list. */
  verifyWebhook: (_req, inbox) => (inbox ? { ok: true } : { ok: false }),

  /** Body: {visitor_id, text, client_id?, name?}. Text is stored verbatim (plain text; every renderer must escape). */
  parseInbound(rawBody): InboundEvent[] {
    let b: { visitor_id?: unknown; text?: unknown; client_id?: unknown; name?: unknown };
    try {
      b = JSON.parse(rawBody);
    } catch {
      return [];
    }
    if (typeof b.visitor_id !== "string" || !VISITOR_ID_RE.test(b.visitor_id)) return [];
    if (typeof b.text !== "string" || !b.text.trim()) return [];
    const cid = typeof b.client_id === "string" && CLIENT_ID_RE.test(b.client_id) ? b.client_id : null;
    return [
      {
        kind: "message",
        externalId: cid ? `${b.visitor_id}:${cid}` : `${b.visitor_id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        sourceId: b.visitor_id,
        contactName: typeof b.name === "string" ? b.name.slice(0, 100) : undefined,
        content: b.text.slice(0, WEBCHAT_MAX_TEXT),
        contentType: "text",
      },
    ];
  },

  async send(_inbox, msg) {
    await assertNotOptedOut(msg);
    const text = textOf(msg);
    if (text.length > WEBCHAT_MAX_TEXT) throw new ChannelError("TOO_LONG", `Web chat messages are limited to ${WEBCHAT_MAX_TEXT} characters`);
    return { externalId: `webchat:${msg.messageId}` };
  },

  mapStatus: () => ({ status: "sent" }),
};
