import { createHmac } from "node:crypto";
import { ChannelError, type ChannelAdapter, type ChannelKind, type InboundEvent, type SessionWindow } from "../types";
import { assertNotOptedOut, providerCall, safeEqual, textOf } from "./_shared";

/**
 * Meta Messenger (Page) + Instagram DM via the Graph API, token-paste flow (no OAuth built).
 *
 * VERIFIED against Meta docs (fetched):
 *  - Webhook GET handshake: hub.mode=subscribe, hub.verify_token, hub.challenge -> 200 + challenge, else 403.
 *  - POST signed with X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, payload). Docs note the payload is the
 *    ESCAPED-unicode form; we verify the raw body and, as a fallback, the escaped form.
 *  - Messenger: object "page"; entry[].id = Page id; entry[].messaging[] {sender.id (PSID), recipient.id, timestamp,
 *    message.mid, message.text | message.attachments}. Send API: POST /{PAGE_ID|me}/messages with a Page access token;
 *    messaging_type RESPONSE|UPDATE|MESSAGE_TAG; success returns recipient_id + message_id.
 *  - Standard messaging window is 24h (up to 7 days after a Click-to-Messenger/Direct ad); a HUMAN_AGENT tag allows a
 *    7-day manual-reply window. NOT implemented here (needs the Human Agent permission; approval UNVERIFIED), so the
 *    adapter honestly enforces 24h and replies use messaging_type RESPONSE.
 *  - Instagram (Instagram Login flavour): POST https://graph.instagram.com/<IG_ID>/messages, recipient.id = IGSID,
 *    message.text UTF-8 <= 1000 bytes; permissions instagram_business_basic + instagram_business_manage_messages; same
 *    24h window.
 * UNVERIFIED: Instagram webhook envelope (object "instagram", entry[].id = IG account id, same messaging[] shape as
 *  Messenger) and the is_echo flag; Messenger 2000-char text limit; Bearer-header auth on both hosts; the /me checks
 *  used at connect time; delivery/read receipts (message_deliveries / messaging_seen) are not wired, so Meta messages
 *  stay "sent".
 * Env: META_APP_SECRET (falls back to WA_APP_SECRET), META_WEBHOOK_VERIFY_TOKEN (falls back to WA_WEBHOOK_VERIFY_TOKEN),
 * META_GRAPH_VERSION (falls back to WA_GRAPH_VERSION, default v21.0).
 */
export const META_WINDOW_MS = 24 * 3600 * 1000;

export const metaAppSecret = () => process.env.META_APP_SECRET || process.env.WA_APP_SECRET || "";
export const metaVerifyToken = () => process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WA_WEBHOOK_VERIFY_TOKEN || "";
const version = () => process.env.META_GRAPH_VERSION || process.env.WA_GRAPH_VERSION || "v21.0";
export const graphFacebook = () => `https://graph.facebook.com/${version()}`;
export const graphInstagram = () => `https://graph.instagram.com/${version()}`;

const escapeUnicode = (s: string) => s.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const secret = metaAppSecret();
  if (!secret || !header) return false;
  for (const payload of [rawBody, escapeUnicode(rawBody)]) {
    const expected = "sha256=" + createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    if (safeEqual(expected, header)) return true;
  }
  return false;
}

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: { type?: string }[]; reply_to?: { mid?: string } };
}

/** Parse the shared page/instagram envelope; `object` selects which adapter's events to return. */
export function parseMetaEnvelope(rawBody: string, object: "page" | "instagram"): InboundEvent[] {
  let body: { object?: string; entry?: { id?: string; messaging?: MessagingEvent[] }[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (body.object !== object) return [];
  const out: InboundEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      const sender = ev.sender?.id;
      if (!m?.mid || !sender || m.is_echo || sender === entry.id) continue; // our own echoes are not inbound
      out.push({
        kind: "message",
        inboxIdentifier: entry.id,
        externalId: m.mid,
        sourceId: sender,
        content: m.text,
        contentType: m.text ? "text" : (m.attachments?.[0]?.type ?? "attachment"),
        replyToExternalId: m.reply_to?.mid,
        sentAt: ev.timestamp ? new Date(ev.timestamp) : undefined,
      });
    }
  }
  return out;
}

function makeAdapter(channel: ChannelKind, object: "page" | "instagram"): ChannelAdapter {
  const isIg = channel === "instagram";
  return {
    channel,
    provider: "meta_graph",
    capabilities: () => ({
      supportsText: true,
      supportsTemplates: false,
      supportsMedia: false,
      supportsButtons: false,
      supportsOutbound: true,
      supportsInbound: true,
      hasSessionWindow: true,
      idempotentSend: false,
      usageMetric: null,
      maxTextLength: isIg ? 1000 : 2000, // IG: 1000 bytes (verified); Messenger 2000 chars UNVERIFIED
    }),
    sessionWindow(conversation, now = new Date()): SessionWindow {
      if (!conversation.last_inbound_at) return { state: "closed", outsideWindowRule: "blocked" };
      const closesAt = new Date(conversation.last_inbound_at.getTime() + META_WINDOW_MS);
      return { state: closesAt.getTime() > now.getTime() ? "open" : "closed", closesAt, outsideWindowRule: "blocked" };
    },
    verifyWebhook(req) {
      if (req.method === "GET") {
        const expected = metaVerifyToken();
        const got = req.query.get("hub.verify_token") ?? "";
        if (req.query.get("hub.mode") === "subscribe" && expected && safeEqual(got, expected)) {
          return { ok: true, response: new Response(req.query.get("hub.challenge") ?? "", { status: 200 }) };
        }
        return { ok: false };
      }
      return verifyMetaSignature(req.rawBody, req.headers.get("x-hub-signature-256")) ? { ok: true } : { ok: false };
    },
    parseInbound: (raw) => parseMetaEnvelope(raw, object),
    async send(inbox, msg) {
      await assertNotOptedOut(msg);
      let text = textOf(msg);
      const token = String(inbox.config.access_token ?? "");
      if (!token) throw new ChannelError("NOT_CONNECTED", "Access token missing; reconnect the channel");
      if (isIg) {
        // 1000 BYTES limit: trim by characters until it fits
        while (Buffer.byteLength(text, "utf8") > 1000) text = text.slice(0, -1);
      } else text = text.slice(0, 2000);
      const base = isIg ? graphInstagram() : graphFacebook();
      const url = `${base}/${encodeURIComponent(inbox.identifier)}/messages`;
      const payload: Record<string, unknown> = { recipient: { id: msg.to }, message: { text } };
      if (!isIg) payload.messaging_type = "RESPONSE";
      const r = await providerCall(
        url,
        { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) },
        { label: isIg ? "Instagram send" : "Messenger send" }
      );
      const id = typeof r.json.message_id === "string" ? r.json.message_id : "";
      if (!id) throw new ChannelError("UNEXPECTED", "Meta send: no message_id in response", { ambiguous: true });
      return { externalId: id, raw: r.json };
    },
    mapStatus: () => ({ status: "sent" }),
  };
}

export const messengerAdapter = makeAdapter("messenger", "page");
export const instagramAdapter = makeAdapter("instagram", "instagram");
