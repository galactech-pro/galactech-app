import { ChannelError, type ChannelAdapter, type InboundEvent } from "../types";
import { NO_WINDOW, assertNotOptedOut, providerCall, safeEqual, textOf } from "./_shared";

/**
 * Telegram Bot API (https://core.telegram.org/bots/api).
 * VERIFIED against the docs (fetched): setWebhook(url, secret_token 1-256 chars [A-Za-z0-9_-], allowed_updates),
 * the secret is echoed in header X-Telegram-Bot-Api-Secret-Token, Message.message_id is unique only WITHIN a chat,
 * Chat.id fits a signed 64-bit int, Update has at most one optional payload field.
 * UNVERIFIED (not re-confirmed in this session): sendMessage text limit 4096 chars; error body shape
 * {ok:false, error_code, description, parameters.retry_after}; HTTP 429 on flood limits. No messaging window exists.
 */
const API = "https://api.telegram.org";

export const telegramApi = (token: string, method: string) => `${API}/bot${token}/${method}`;

interface TgUser { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean }
interface TgMessage { message_id: number; date: number; chat: { id: number; type: string }; from?: TgUser; text?: string; caption?: string; reply_to_message?: { message_id: number } }

function contentTypeOf(m: Record<string, unknown>): string {
  for (const k of ["photo", "video", "audio", "voice", "document", "sticker", "location", "contact", "animation", "video_note"]) if (k in m) return k;
  return "text";
}

export const telegramAdapter: ChannelAdapter = {
  channel: "telegram",
  provider: "telegram_bot",

  capabilities: () => ({
    supportsText: true,
    supportsTemplates: false,
    supportsMedia: false, // inbound media is recorded as "[photo]" etc.; outbound media not implemented
    supportsButtons: false,
    supportsOutbound: true,
    supportsInbound: true,
    hasSessionWindow: false, // Telegram has no 24h-style window (a user must have started the bot, but nothing expires)
    idempotentSend: false, // sendMessage has no idempotency key
    usageMetric: null,
    maxTextLength: 4096,
  }),

  sessionWindow: () => ({ ...NO_WINDOW }),

  /** Header must equal the per-inbox secret_token we registered with setWebhook. Constant-time. */
  verifyWebhook(req, inbox) {
    const expected = typeof inbox?.config.secret_token === "string" ? inbox.config.secret_token : "";
    const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    return expected && got && safeEqual(got, expected) ? { ok: true } : { ok: false };
  },

  parseInbound(rawBody): InboundEvent[] {
    let u: { update_id?: number; message?: TgMessage };
    try {
      u = JSON.parse(rawBody);
    } catch {
      return [];
    }
    const m = u.message;
    if (!m || m.chat?.type !== "private" || m.from?.is_bot) return []; // only 1:1 chats; groups/channels are out of scope
    const chatId = String(m.chat.id);
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username;
    const type = contentTypeOf(m as unknown as Record<string, unknown>);
    return [
      {
        kind: "message",
        // message_id is only unique per chat -> compose with the chat id
        externalId: `${chatId}:${m.message_id}`,
        sourceId: chatId,
        contactName: name,
        content: m.text ?? m.caption ?? undefined,
        contentType: type,
        replyToExternalId: m.reply_to_message ? `${chatId}:${m.reply_to_message.message_id}` : undefined,
        sentAt: new Date(m.date * 1000),
      },
    ];
  },

  async send(inbox, msg) {
    await assertNotOptedOut(msg);
    const text = textOf(msg);
    const token = String(inbox.config.bot_token ?? "");
    if (!token) throw new ChannelError("NOT_CONNECTED", "Telegram bot token missing; reconnect the channel");
    const r = await providerCall(
      telegramApi(token, "sendMessage"),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: msg.to, text: text.slice(0, 4096) }) },
      { label: "Telegram sendMessage" }
    );
    const result = r.json.result as { message_id?: number } | undefined;
    if (r.json.ok !== true || result?.message_id === undefined) throw new ChannelError("UNEXPECTED", "Telegram sendMessage: unexpected response", { ambiguous: true });
    return { externalId: `${msg.to}:${result.message_id}`, raw: r.json };
  },

  // Telegram sends no delivery receipts to bots.
  mapStatus: () => ({ status: "sent" }),
};
