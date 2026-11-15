import { placeVapiCall, verifyVapiSecret } from "@/lib/voice/vapi";
import { ChannelError, type ChannelAdapter, type InboundEvent, type MessageStatus } from "../types";

/**
 * Voice via Vapi: OUTBOUND calls + call events only. A call is one outbound `messages` row (external_id = Vapi call id);
 * ai_calls remains the detail table. Call lifecycle webhooks are handled by lib/channels/voice-events.ts, not by
 * parseInbound (they are not chat messages).
 */
export const vapiVoiceAdapter: ChannelAdapter = {
  channel: "voice",
  provider: "vapi",

  capabilities: () => ({
    supportsText: false,
    supportsTemplates: false,
    supportsMedia: false,
    supportsButtons: false,
    supportsOutbound: true,
    supportsInbound: false,
    hasSessionWindow: false,
    idempotentSend: false, // POST /call is not idempotent: never re-dial on ambiguity
    usageMetric: "ai_calls",
  }),

  sessionWindow: () => ({ state: "n/a", outsideWindowRule: "none" }),

  verifyWebhook(req) {
    const r = new Request("http://local/", { headers: req.headers });
    return verifyVapiSecret(r) ? { ok: true } : { ok: false };
  },

  parseInbound: (): InboundEvent[] => [],

  async send(_inbox, msg) {
    if (msg.content.kind !== "voice_call") throw new ChannelError("UNSUPPORTED_CONTENT", "Voice adapter only places calls");
    const r = await placeVapiCall({
      orgId: msg.orgId,
      contactId: msg.contactId,
      to: msg.to,
      script: msg.content.script ?? "",
      firstMessage: msg.content.firstMessage ?? "Hello, this is an AI assistant calling.",
      attempt: msg.content.attempt ?? 1,
    });
    return { externalId: r.vapiCallId, raw: r };
  },

  mapStatus(providerStatus): { status: MessageStatus } {
    // A call message is 'sent' once Vapi accepted the call; later call states live on ai_calls.
    const s = providerStatus.toLowerCase();
    if (s.includes("fail") || s.includes("error")) return { status: "failed" };
    return { status: "sent" };
  },
};
