import { createHmac } from "node:crypto";
import { appUrl } from "@/lib/env";
import { ChannelError, type ChannelAdapter, type InboundEvent, type MessageStatus } from "../types";
import { NO_WINDOW, providerCall, safeEqual, textOf } from "./_shared";

/**
 * SMS via Twilio (only provider implemented; keyed by provider "twilio" so another provider can sit beside it).
 * VERIFIED (Twilio docs fetched): POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json with To,
 * From | MessagingServiceSid, Body (<=1600 chars), StatusCallback; response has sid + status; statuses: queued,
 * sending, sent, failed, delivered, undelivered, receiving, received, accepted, scheduled, read, canceled; inbound
 * webhook params MessageSid, AccountSid, From, To, Body, NumMedia, MessagingServiceSid; status callback has
 * MessageStatus and ErrorCode; signature = HMAC-SHA1(auth token), base64, over the full URL (as configured, with
 * query) + POST params sorted alphabetically; JSON bodies use bodySHA256 (we only accept form bodies).
 * UNVERIFIED: the exact "key+value, no separator" concatenation (the docs page defers to the SDK; this follows the
 * Twilio SDK as known from memory), Basic auth (account sid:auth token) on the Messages API, that MessageSid is present
 * on status callbacks, and any Twilio-side idempotency (none assumed -> idempotentSend=false).
 * INDIA DLT: commercial SMS to Indian numbers is understood to need DLT registration (entity, sender ID, templates).
 * Requirements are UNVERIFIED here and are the organisation's responsibility; we do not validate or claim any detail.
 */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const entries = [...params.entries()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const data = url + entries.map(([k, v]) => k + v).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export const smsWebhookUrl = (token: string, kind: "inbound" | "status") => `${appUrl()}/api/webhooks/sms/${token}${kind === "status" ? "/status" : ""}`;

function mapTwilioStatus(s: string): MessageStatus {
  switch (s.toLowerCase()) {
    case "sent": return "sent";
    case "delivered": return "delivered";
    case "read": return "read";
    case "failed": case "undelivered": case "canceled": return "failed";
    default: return "queued"; // queued/accepted/scheduled/sending: nothing to record
  }
}

/** Parse a Twilio status-callback form body (used by the /status route). */
export function parseTwilioStatus(rawBody: string): InboundEvent[] {
  const p = new URLSearchParams(rawBody);
  const sid = p.get("MessageSid") ?? p.get("SmsSid");
  const st = p.get("MessageStatus") ?? p.get("SmsStatus");
  if (!sid || !st) return [];
  const status = mapTwilioStatus(st);
  if (status === "queued") return [];
  const code = p.get("ErrorCode") ?? undefined;
  return [{ kind: "status", externalId: sid, status, errorCode: code, error: code ? `Twilio error ${code}` : undefined }];
}

export const twilioSmsAdapter: ChannelAdapter = {
  channel: "sms",
  provider: "twilio",
  capabilities: () => ({
    supportsText: true,
    supportsTemplates: false,
    supportsMedia: false,
    supportsButtons: false,
    supportsOutbound: true,
    supportsInbound: true,
    hasSessionWindow: false,
    idempotentSend: false,
    usageMetric: null, // SMS is not metered yet (no plan_limits column)
    maxTextLength: 1600,
  }),
  sessionWindow: () => ({ ...NO_WINDOW }),

  /** Per-inbox auth token; the URL is rebuilt from NEXT_PUBLIC_APP_URL + the inbox webhook token (not from Host headers). */
  verifyWebhook(req, inbox) {
    const authToken = typeof inbox?.config.auth_token === "string" ? inbox.config.auth_token : "";
    const wt = typeof inbox?.config.webhook_token === "string" ? inbox.config.webhook_token : "";
    const sig = req.headers.get("x-twilio-signature");
    if (!authToken || !wt || !sig) return { ok: false };
    const isStatus = req.query.get("kind") === "status";
    const url = smsWebhookUrl(wt, isStatus ? "status" : "inbound") + (isStatus ? "?kind=status" : "");
    const expected = twilioSignature(authToken, url, new URLSearchParams(req.rawBody));
    return safeEqual(expected, sig) ? { ok: true } : { ok: false };
  },

  parseInbound(rawBody): InboundEvent[] {
    const p = new URLSearchParams(rawBody);
    const sid = p.get("MessageSid");
    const from = p.get("From");
    if (!sid || !from || p.get("MessageStatus")) return [];
    const media = Number(p.get("NumMedia") ?? "0") || 0;
    const body = p.get("Body") ?? "";
    return [
      {
        kind: "message",
        inboxIdentifier: p.get("To") ?? undefined,
        externalId: sid,
        sourceId: from,
        contactPhone: from,
        content: body || undefined,
        contentType: media > 0 && !body ? "media" : "text",
        attachments: Array.from({ length: Math.min(media, 10) }, (_, i) => ({ type: p.get(`MediaContentType${i}`) ?? "media", url: p.get(`MediaUrl${i}`) ?? undefined })),
      },
    ];
  },

  async send(inbox, msg) {
    const text = textOf(msg);
    const sid = String(inbox.config.account_sid ?? "");
    const token = String(inbox.config.auth_token ?? "");
    const from = typeof inbox.config.from === "string" ? inbox.config.from : "";
    const svc = typeof inbox.config.messaging_service_sid === "string" ? inbox.config.messaging_service_sid : "";
    const wt = typeof inbox.config.webhook_token === "string" ? inbox.config.webhook_token : "";
    if (!sid || !token || (!from && !svc)) throw new ChannelError("NOT_CONNECTED", "Twilio credentials incomplete; reconnect the channel");
    const form = new URLSearchParams({ To: msg.to, Body: text.slice(0, 1600) });
    if (svc) form.set("MessagingServiceSid", svc);
    else form.set("From", from);
    if (wt) {
      try {
        form.set("StatusCallback", smsWebhookUrl(wt, "status") + "?kind=status");
      } catch {
        /* app URL unset: send without delivery receipts */
      }
    }
    const r = await providerCall(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") },
        body: form.toString(),
      },
      { label: "Twilio send" }
    );
    const id = typeof r.json.sid === "string" ? r.json.sid : "";
    if (!id) throw new ChannelError("UNEXPECTED", "Twilio: no sid in response", { ambiguous: true });
    return { externalId: id, raw: { sid: id, status: r.json.status } };
  },

  mapStatus: (s) => ({ status: mapTwilioStatus(s) }),
};
