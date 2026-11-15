import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { ApiError } from "@/lib/api";
import { appUrl, clickSignature, fromAddress, trackingToken, unsubscribeToken } from "@/lib/email/tokens";
import { ChannelError, type ChannelAdapter, type InboxCtx, type MessageStatus } from "../types";

const TIMEOUT_MS = Number(process.env.EMAIL_HTTP_TIMEOUT_MS) || 15_000;

async function resendKey(inbox: InboxCtx): Promise<string> {
  const cfg = inbox.config;
  if (cfg.source !== "org" && typeof cfg.api_key === "string" && cfg.api_key) return cfg.api_key;
  const org = await prisma.organisations.findUnique({ where: { id: inbox.org_id }, select: { resend_api_key: true } });
  let key: string | undefined;
  if (org?.resend_api_key) {
    try {
      key = decrypt(org.resend_api_key);
    } catch {
      key = undefined;
    }
  }
  key = key || process.env.RESEND_API_KEY;
  if (!key) throw new ApiError(400, "Email is not configured (no Resend API key)");
  return key;
}

function rewriteLinks(html: string, token: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, url: string) => {
    if (url.includes("/api/email/")) return `href="${url}"`;
    return `href="${appUrl()}/api/email/track/click?t=${token}&u=${encodeURIComponent(url)}&s=${clickSignature(token, url)}"`;
  });
}

/** Email via Resend (HTTP API, no SDK). Outbound only for now: inbound/bounce webhooks are not wired (payloads UNVERIFIED). */
export const resendEmailAdapter: ChannelAdapter = {
  channel: "email",
  provider: "resend",

  capabilities: () => ({
    supportsText: true,
    supportsTemplates: false,
    supportsMedia: false,
    supportsButtons: false,
    supportsOutbound: true,
    supportsInbound: false,
    hasSessionWindow: false,
    // We send an Idempotency-Key header, but whether Resend honours it is UNVERIFIED here, so ambiguous failures are
    // only retried when RESEND_IDEMPOTENT_RETRY=1 is set explicitly.
    idempotentSend: process.env.RESEND_IDEMPOTENT_RETRY === "1",
    usageMetric: "emails",
  }),

  sessionWindow: () => ({ state: "n/a", outsideWindowRule: "none" }),
  verifyWebhook: () => ({ ok: false }),
  parseInbound: () => [],

  async send(inbox, msg) {
    if (msg.content.kind !== "email") throw new ChannelError("UNSUPPORTED_CONTENT", "Email adapter only sends email content");
    const key = await resendKey(inbox);
    const unsubUrl = `${appUrl()}/api/email/unsubscribe?t=${unsubscribeToken(msg.contactId)}`;
    const token = trackingToken(msg.messageId);
    let html = rewriteLinks(msg.content.html, token);
    html += `<p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Don't want these emails? <a href="${unsubUrl}">Unsubscribe</a></p>`;
    html += `<img src="${appUrl()}/api/email/track/open?t=${token}" width="1" height="1" alt="" style="display:none" />`;

    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": msg.messageId },
        body: JSON.stringify({
          from: fromAddress(),
          to: msg.to,
          subject: msg.content.subject,
          html,
          headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ChannelError("NETWORK", "No response from the email provider", { ambiguous: true });
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (res.ok && json.id) return { externalId: json.id, raw: json };
    const m = json.message ?? `Email provider error ${res.status}`;
    if (res.status === 429) throw new ChannelError("RATE_LIMITED", m, { retryable: true, httpStatus: 429 });
    if (res.status >= 500 || res.ok) throw new ChannelError(json.name ?? String(res.status), m, { ambiguous: true, httpStatus: res.status });
    throw new ChannelError(json.name ?? String(res.status), m, { httpStatus: res.status });
  },

  mapStatus(providerStatus): { status: MessageStatus } {
    const s = providerStatus.toLowerCase();
    if (s.includes("deliver")) return { status: "delivered" };
    if (s.includes("bounce") || s.includes("fail")) return { status: "failed" };
    if (s.includes("sent")) return { status: "sent" };
    return { status: "queued" };
  },
};
