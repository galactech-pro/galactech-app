import type { channel as ChannelKind } from "@/lib/db";

export type { ChannelKind };
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";

/** A decrypted inbox. `config` is the parsed JSON stored (AES-GCM encrypted) in inboxes.config. */
export interface InboxCtx {
  id: string;
  org_id: string;
  channel: ChannelKind;
  provider: string;
  identifier: string;
  name: string;
  is_active: boolean;
  config: Record<string, unknown>;
}

export interface Capabilities {
  supportsText: boolean;
  supportsTemplates: boolean;
  supportsMedia: boolean;
  supportsButtons: boolean;
  /** Adapter can place/send outbound messages (campaigns, automations, replies). */
  supportsOutbound: boolean;
  /** Adapter can receive inbound messages / status callbacks via webhook. */
  supportsInbound: boolean;
  /** Provider has a customer-service window after which only templates are allowed (WhatsApp 24h). */
  hasSessionWindow: boolean;
  /** True only when the provider de-duplicates sends by an idempotency key, so ambiguous failures may be retried. */
  idempotentSend: boolean;
  /** Usage metric reserved before each send (plan limits). null = not metered yet. */
  usageMetric: "wa_messages" | "emails" | "ai_calls" | null;
  maxTextLength?: number;
}

export interface SessionWindow {
  state: "open" | "closed" | "n/a";
  closesAt?: Date;
  outsideWindowRule: "template_only" | "none" | "blocked";
}

export type OutboundContent =
  | { kind: "text"; text: string }
  | { kind: "template"; name: string; params?: string[]; language?: string }
  | { kind: "media"; type: "image" | "document" | "video" | "audio"; url: string; caption?: string }
  | { kind: "interactive"; body: string; buttons: { id: string; title: string }[] }
  | { kind: "email"; subject: string; html: string; text?: string }
  | { kind: "voice_call"; script?: string; firstMessage?: string; attempt?: number };

export interface OutboundMessage {
  /** Contact address on this channel (phone, email, chat id...). */
  to: string;
  content: OutboundContent;
  /** Our messages.id (outbox row). Use it as the provider idempotency key when the provider supports one. */
  messageId: string;
  idempotencyKey: string;
  orgId: string;
  contactId: string;
  campaignId?: string | null;
}

export interface SendResult {
  externalId: string;
  raw?: unknown;
}

export interface InboundAttachment {
  type: string;
  url?: string;
  providerMediaId?: string;
  mime?: string;
}

/** Normalised webhook event. One webhook POST may produce many of these (possibly for several inboxes). */
export interface InboundEvent {
  kind: "message" | "status";
  /** Identifier of the receiving inbox as the provider reports it (e.g. WhatsApp metadata.phone_number_id). */
  inboxIdentifier?: string;
  /** Provider message id. For status events: id of the OUTBOUND message being updated. */
  externalId: string;
  // message fields
  sourceId?: string; // contact address on the channel (phone for whatsapp)
  contactName?: string;
  contactPhone?: string; // E.164 if the channel is phone based
  contactEmail?: string;
  content?: string;
  contentType?: string;
  attachments?: InboundAttachment[];
  replyToExternalId?: string;
  sentAt?: Date;
  // status fields
  status?: MessageStatus;
  errorCode?: string;
  error?: string;
  raw?: unknown;
}

export interface WebhookRequest {
  method: string;
  headers: Headers;
  rawBody: string;
  query: URLSearchParams;
}

export interface ChannelAdapter {
  readonly channel: ChannelKind;
  readonly provider: string;
  capabilities(inbox?: InboxCtx): Capabilities;
  /** Pure function of the conversation's last inbound time. */
  sessionWindow(conversation: { last_inbound_at: Date | null }, now?: Date): SessionWindow;
  /** Verify signature/secret on the RAW body. Must be constant-time. */
  verifyWebhook(req: WebhookRequest, inbox?: InboxCtx | null): { ok: true; response?: Response } | { ok: false };
  parseInbound(rawBody: string): InboundEvent[];
  /**
   * Perform exactly ONE provider call. Throw ChannelError. Do not loop on ambiguous failures
   * (timeouts/5xx) unless capabilities.idempotentSend is true.
   */
  send(inbox: InboxCtx, msg: OutboundMessage): Promise<SendResult>;
  mapStatus(providerStatus: string, providerError?: unknown): { status: MessageStatus; errorCode?: string };
  setupWebhook?(inbox: InboxCtx, url: string): Promise<void>;
}

/**
 * Error from an adapter.
 *  - ambiguous=true  : the provider may or may not have accepted the message (timeout, network, 5xx). NEVER blind-retry.
 *  - retryable=true  : definitely NOT accepted and worth retrying shortly (e.g. HTTP 429).
 *  - neither         : definitive rejection -> message is marked failed.
 */
export class ChannelError extends Error {
  name = "ChannelError";
  constructor(
    public code: string,
    message: string,
    public opts: { retryable?: boolean; ambiguous?: boolean; httpStatus?: number } = {}
  ) {
    super(message);
  }
  get retryable() {
    return !!this.opts.retryable;
  }
  get ambiguous() {
    return !!this.opts.ambiguous;
  }
}

/** Typed failure raised by sendOutbound. `messageId` is the outbox row (already marked failed when it exists). */
export type OutboundErrorCode =
  | "SESSION_WINDOW_EXPIRED"
  | "TEMPLATE_REQUIRED"
  | "CHANNEL_NOT_SUPPORTED"
  | "CHANNEL_NOT_CONNECTED"
  | "NO_ADDRESS"
  | "PROVIDER_REJECTED";

export class OutboundError extends Error {
  name = "OutboundError";
  constructor(public code: OutboundErrorCode, message: string, public messageId?: string) {
    super(message);
  }
}
