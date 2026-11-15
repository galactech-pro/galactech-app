import { NextResponse } from "next/server";
import { buildWaPayload, graphSend, inboxCreds } from "@/lib/whatsapp/graph";
import { parseWebhook, safeEqual, verifySignature } from "@/lib/whatsapp/webhook";
import type { ChannelAdapter, InboundEvent, MessageStatus } from "../types";

const WINDOW_MS = 24 * 3600 * 1000;

/** WhatsApp Cloud API (Meta, direct). Wraps lib/whatsapp. */
export const whatsappCloudAdapter: ChannelAdapter = {
  channel: "whatsapp",
  provider: "whatsapp_cloud",

  capabilities: () => ({
    supportsText: true,
    supportsTemplates: true,
    supportsMedia: true,
    supportsButtons: true,
    supportsOutbound: true,
    supportsInbound: true,
    hasSessionWindow: true,
    idempotentSend: false, // Cloud API has no idempotency key: never blind-retry
    usageMetric: "wa_messages",
    maxTextLength: 4096,
  }),

  sessionWindow(conversation, now = new Date()) {
    if (!conversation.last_inbound_at) return { state: "closed", outsideWindowRule: "template_only" };
    const closesAt = new Date(conversation.last_inbound_at.getTime() + WINDOW_MS);
    return { state: closesAt.getTime() > now.getTime() ? "open" : "closed", closesAt, outsideWindowRule: "template_only" };
  },

  verifyWebhook(req) {
    if (req.method === "GET") {
      const expected = process.env.WA_WEBHOOK_VERIFY_TOKEN;
      const got = req.query.get("hub.verify_token") ?? "";
      if (req.query.get("hub.mode") === "subscribe" && expected && safeEqual(got, expected)) {
        return { ok: true, response: new NextResponse(req.query.get("hub.challenge") ?? "", { status: 200 }) };
      }
      return { ok: false };
    }
    return verifySignature(req.rawBody, req.headers.get("x-hub-signature-256")) ? { ok: true } : { ok: false };
  },

  parseInbound(rawBody): InboundEvent[] {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return [];
    }
    const { messages, statuses } = parseWebhook(body);
    const events: InboundEvent[] = [];
    for (const m of messages) {
      events.push({
        kind: "message",
        inboxIdentifier: m.phoneNumberId,
        externalId: m.waMessageId,
        sourceId: m.from,
        contactPhone: m.from,
        contactName: m.profileName,
        content: m.text,
        contentType: m.type,
        replyToExternalId: m.replyToWaId,
        sentAt: m.timestamp,
      });
    }
    for (const s of statuses) {
      const mapped = whatsappCloudAdapter.mapStatus(s.status);
      events.push({
        kind: "status",
        inboxIdentifier: s.phoneNumberId,
        externalId: s.waMessageId,
        status: mapped.status,
        errorCode: s.errorCode,
        error: s.error,
        sentAt: s.timestamp,
      });
    }
    return events;
  },

  async send(inbox, msg) {
    const creds = await inboxCreds(inbox);
    const json = await graphSend(creds, buildWaPayload(msg.to, msg.content));
    const id = (json.messages as { id?: string }[] | undefined)?.[0]?.id ?? "";
    return { externalId: id, raw: json };
  },

  mapStatus(providerStatus): { status: MessageStatus } {
    const s = providerStatus.toLowerCase();
    if (s === "sent" || s === "delivered" || s === "read" || s === "failed") return { status: s };
    return { status: "queued" };
  },
};
