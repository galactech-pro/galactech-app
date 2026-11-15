import { ChannelError, type ChannelAdapter } from "../types";
import { NO_WINDOW } from "./_shared";

/**
 * Generic inbound API channel: external systems POST messages to /api/public/v1/messages (API key, Pro plan).
 * Inbound only. An outbound callback/webhook to the external system is OUT OF SCOPE for now, so supportsOutbound is
 * false (the channel is not offered for campaigns and replies are rejected with CHANNEL_NOT_SUPPORTED).
 */
export const apiAdapter: ChannelAdapter = {
  channel: "api",
  provider: "api",
  capabilities: () => ({
    supportsText: true,
    supportsTemplates: false,
    supportsMedia: false,
    supportsButtons: false,
    supportsOutbound: false,
    supportsInbound: true,
    hasSessionWindow: false,
    idempotentSend: false,
    usageMetric: null,
  }),
  sessionWindow: () => ({ ...NO_WINDOW }),
  verifyWebhook: () => ({ ok: false }), // not a webhook channel: authenticated by API key in the route
  parseInbound: () => [],
  async send() {
    throw new ChannelError("NOT_SUPPORTED", "The API channel is inbound-only");
  },
  mapStatus: () => ({ status: "sent" }),
};
