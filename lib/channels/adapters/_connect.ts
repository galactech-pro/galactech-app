import { randomBytes } from "node:crypto";
import { prisma, type channel, type inboxes } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { encrypt } from "@/lib/crypto";
import { appUrl } from "@/lib/env";
import { isUniqueViolation, toInboxCtx } from "../inbox";
import type { InboxCtx } from "../types";
import { providerCall } from "./_shared";
import { telegramApi } from "./telegram";
import { graphFacebook, graphInstagram } from "./meta";
import { normalizeOrigin } from "./_webchat";
import { smsWebhookUrl } from "./sms-twilio";

const newToken = () => randomBytes(24).toString("hex"); // 48 hex chars (inboxByToken pattern)

export interface ConnectResult {
  inbox_id: string;
  channel: channel;
  name: string;
  identifier: string;
  webhook_url?: string;
  extra_urls?: Record<string, string>;
  /** Shown ONCE in the UI. Present only when a secret must be copied by the user (none of the current flows need one). */
  secret?: string;
  snippet?: string;
  notes: string[];
}

/**
 * Create (or reconnect) an inbox. identifier is unique per channel: a row owned by ANOTHER org yields a generic 409;
 * the same org reconnecting updates credentials and keeps the webhook_token. `activate=false` creates it inactive so a
 * failing provider setup (e.g. Telegram setWebhook) never leaves a live half-configured inbox.
 */
async function upsertInbox(
  orgId: string,
  d: { channel: channel; provider: string; name: string; identifier: string; config: (token: string) => Record<string, unknown>; activate: boolean }
): Promise<{ row: inboxes; token: string }> {
  // tenant-ok: global (channel, identifier) uniqueness check; ownership compared to orgId right below
  const existing = await prisma.inboxes.findUnique({ where: { channel_identifier: { channel: d.channel, identifier: d.identifier } } });
  if (existing) {
    if (existing.org_id !== orgId) throw new ApiError(409, "This account is already connected to another organisation");
    const row = await prisma.inboxes.update({
      where: { id: existing.id, org_id: orgId },
      data: { name: d.name, provider: d.provider, config: encrypt(JSON.stringify(d.config(existing.webhook_token))), is_active: d.activate },
    });
    return { row, token: existing.webhook_token };
  }
  const token = newToken();
  try {
    const row = await prisma.inboxes.create({
      data: { org_id: orgId, channel: d.channel, provider: d.provider, name: d.name, identifier: d.identifier, config: encrypt(JSON.stringify(d.config(token))), webhook_token: token, is_active: d.activate },
    });
    return { row, token };
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError(409, "This account is already connected");
    throw e;
  }
}

export async function connectTelegram(orgId: string, botToken: string, name?: string): Promise<ConnectResult> {
  if (!/^\d{3,20}:[A-Za-z0-9_-]{20,80}$/.test(botToken)) throw new ApiError(422, "That does not look like a Telegram bot token (format 123456:ABC...)");
  const me = await providerCall(telegramApi(botToken, "getMe"), { method: "GET" }, { label: "Telegram getMe" }).catch((e) => {
    throw new ApiError(422, `Telegram rejected the bot token (${e instanceof Error ? e.message : "error"})`);
  });
  const bot = me.json.result as { id?: number; username?: string; first_name?: string } | undefined;
  if (me.json.ok !== true || !bot?.id) throw new ApiError(422, "Telegram rejected the bot token");
  const secret = randomBytes(32).toString("base64url"); // [A-Za-z0-9_-], 43 chars (limit 256, verified)
  const { row, token } = await upsertInbox(orgId, {
    channel: "telegram",
    provider: "telegram_bot",
    name: name?.trim() || `Telegram @${bot.username ?? bot.id}`,
    identifier: String(bot.id),
    config: () => ({ bot_token: botToken, secret_token: secret, bot_username: bot.username ?? null }),
    activate: false,
  });
  const url = `${appUrl()}/api/webhooks/telegram/${token}`;
  try {
    const r = await providerCall(
      telegramApi(botToken, "setWebhook"),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"] }) },
      { label: "Telegram setWebhook" }
    );
    if (r.json.ok !== true) throw new Error("setWebhook returned ok=false");
  } catch (e) {
    throw new ApiError(502, `Bot verified but webhook registration failed (Telegram needs a public HTTPS URL): ${e instanceof Error ? e.message : "error"}`);
  }
  await prisma.inboxes.updateMany({ where: { id: row.id, org_id: orgId }, data: { is_active: true } });
  return {
    inbox_id: row.id, channel: "telegram", name: row.name, identifier: row.identifier, webhook_url: url,
    notes: ["Webhook registered automatically with a per-bot secret token (no manual step).", "Customers must start the bot first; Telegram has no messaging window."],
  };
}

export async function connectMeta(orgId: string, ch: "messenger" | "instagram", d: { account_id: string; access_token: string; name?: string }): Promise<ConnectResult> {
  const id = d.account_id.trim();
  if (!/^\d{5,25}$/.test(id)) throw new ApiError(422, ch === "messenger" ? "Page ID must be numeric" : "Instagram account ID must be numeric");
  // Token sanity check (UNVERIFIED endpoints/fields; a failure is a hard stop so we never store a dead token):
  const base = ch === "messenger" ? graphFacebook() : graphInstagram();
  const fields = ch === "messenger" ? "id,name" : "user_id,username";
  const me = await providerCall(`${base}/me?fields=${fields}`, { headers: { authorization: `Bearer ${d.access_token}` } }, { label: "Meta token check" }).catch((e) => {
    throw new ApiError(422, `Meta rejected the access token (${e instanceof Error ? e.message : "error"})`);
  });
  if (ch === "messenger" && me.json.id && String(me.json.id) !== id) throw new ApiError(422, "The access token belongs to a different Page than the Page ID you entered");
  if (ch === "instagram") {
    const got = me.json.user_id ?? me.json.id;
    if (got && String(got) !== id) throw new ApiError(422, "The access token belongs to a different Instagram account than the ID you entered");
  }
  const { row } = await upsertInbox(orgId, {
    channel: ch,
    provider: "meta_graph",
    name: d.name?.trim() || (ch === "messenger" ? `Messenger ${String(me.json.name ?? id)}` : `Instagram ${String(me.json.username ?? id)}`),
    identifier: id,
    config: () => ({ access_token: d.access_token }),
    activate: true,
  });
  return {
    inbox_id: row.id, channel: ch, name: row.name, identifier: row.identifier, webhook_url: `${appUrl()}/api/webhooks/meta`,
    notes: [
      "In your Meta app: Webhooks > add this callback URL and the verify token from META_WEBHOOK_VERIFY_TOKEN (server env), then subscribe the " + (ch === "messenger" ? "Page" : "Instagram") + " object to the messages field.",
      "Webhook requests are verified with the app secret (META_APP_SECRET, falls back to WA_APP_SECRET), shared by all inboxes of this Meta app.",
      "Replies are only allowed within 24 hours of the customer's last message. The 7-day Human Agent tag is not implemented.",
      "UNVERIFIED: token endpoint and Instagram webhook payload shape were not tested against live Meta accounts.",
    ],
  };
}

export async function connectSms(
  orgId: string,
  d: { account_sid: string; auth_token: string; from?: string; messaging_service_sid?: string; name?: string }
): Promise<ConnectResult> {
  if (!/^AC[a-f0-9]{32}$/i.test(d.account_sid)) throw new ApiError(422, "Account SID must start with AC (34 characters)");
  const from = d.from?.trim() || "";
  const svc = d.messaging_service_sid?.trim() || "";
  if (!from && !svc) throw new ApiError(422, "Provide a From number (E.164) or a Messaging Service SID");
  if (from && !/^\+\d{8,15}$/.test(from)) throw new ApiError(422, "From must be an E.164 number like +14155550123");
  if (svc && !/^MG[a-f0-9]{32}$/i.test(svc)) throw new ApiError(422, "Messaging Service SID must start with MG");
  // credential check (UNVERIFIED: Basic auth account sid:auth token on GET /Accounts/{sid}.json)
  await providerCall(
    `https://api.twilio.com/2010-04-01/Accounts/${d.account_sid}.json`,
    { headers: { authorization: "Basic " + Buffer.from(`${d.account_sid}:${d.auth_token}`).toString("base64") } },
    { label: "Twilio credential check" }
  ).catch((e) => {
    throw new ApiError(422, `Twilio rejected the credentials (${e instanceof Error ? e.message : "error"})`);
  });
  const { row, token } = await upsertInbox(orgId, {
    channel: "sms",
    provider: "twilio",
    name: d.name?.trim() || `SMS ${from || svc}`,
    identifier: from || svc, // inbound `To` is the number; for messaging-service inboxes inbound is routed by token
    config: (t) => ({ account_sid: d.account_sid, auth_token: d.auth_token, from: from || null, messaging_service_sid: svc || null, webhook_token: t }),
    activate: true,
  });
  return {
    inbox_id: row.id, channel: "sms", name: row.name, identifier: row.identifier,
    webhook_url: smsWebhookUrl(token, "inbound"),
    extra_urls: { status_callback: smsWebhookUrl(token, "status") + "?kind=status" },
    notes: [
      "In the Twilio console set the number's (or Messaging Service's) incoming-message webhook to the URL above (HTTP POST). The status callback URL is attached to each outbound message automatically.",
      "Requests are verified with X-Twilio-Signature using your auth token. The URL must be exactly the one above (NEXT_PUBLIC_APP_URL).",
      "India: commercial SMS needs DLT registration. This is UNVERIFIED here and is your organisation's responsibility; we do not check it.",
    ],
  };
}

export async function connectWebchat(
  orgId: string,
  d: { name?: string; allowed_origins: string[]; title?: string; welcome?: string; color?: string; collect_details?: boolean }
): Promise<ConnectResult> {
  const origins = [...new Set(d.allowed_origins.map((o) => normalizeOrigin(o)).filter((o): o is string => !!o))];
  if (origins.length === 0) throw new ApiError(422, "Add at least one allowed website origin, e.g. https://www.example.com");
  const { row, token } = await upsertInbox(orgId, {
    channel: "webchat",
    provider: "webchat",
    name: d.name?.trim() || "Web chat",
    identifier: `webchat:${randomBytes(8).toString("hex")}`,
    config: () => ({ allowed_origins: origins, title: d.title?.trim() || "", welcome: d.welcome?.trim() || "", color: d.color || "", collect_details: !!d.collect_details }),
    activate: true,
  });
  return { inbox_id: row.id, channel: "webchat", name: row.name, identifier: row.identifier, webhook_url: `${appUrl()}/api/webhooks/webchat/${token}`, snippet: webchatSnippet(token), notes: ["Paste the snippet before </body> on pages served from an allowed origin."] };
}

export const webchatSnippet = (token: string) => `<script src="${appUrl()}/webchat.js" data-token="${token}" async></script>`;

export async function ensureApiInbox(orgId: string): Promise<InboxCtx> {
  const identifier = `api:${orgId}`;
  // tenant-ok: identifier embeds the org id; row org checked below
  const found = await prisma.inboxes.findUnique({ where: { channel_identifier: { channel: "api", identifier } } });
  if (found) {
    if (found.org_id !== orgId) throw new ApiError(409, "Conflict");
    return toInboxCtx(found.is_active ? found : await prisma.inboxes.update({ where: { id: found.id, org_id: orgId }, data: { is_active: true } }));
  }
  const { row } = await upsertInbox(orgId, { channel: "api", provider: "api", name: "API", identifier, config: () => ({}), activate: true });
  return toInboxCtx(row);
}

export async function connectApi(orgId: string): Promise<ConnectResult> {
  const ib = await ensureApiInbox(orgId);
  return {
    inbox_id: ib.id, channel: "api", name: ib.name, identifier: ib.identifier, webhook_url: `${appUrl()}/api/public/v1/messages`,
    notes: ["POST JSON {source_id, content, external_id?, name?, email?, phone?} with an API key (Pro plan). Inbound only; there is no outbound callback yet."],
  };
}

/** Best-effort provider cleanup on disconnect (Telegram webhook removal). Never throws. */
export async function providerCleanup(inbox: InboxCtx): Promise<void> {
  if (inbox.channel === "telegram" && typeof inbox.config.bot_token === "string") {
    await providerCall(telegramApi(inbox.config.bot_token, "deleteWebhook"), { method: "POST" }, { label: "Telegram deleteWebhook" }).catch(() => undefined);
  }
}
