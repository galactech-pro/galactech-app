import { prisma } from "@/lib/db";
import { ChannelError, type ChannelAdapter, type MessageStatus } from "../types";
import { NO_WINDOW } from "./_shared";
import { decorateEmailHtml } from "./email";
import { sendViaSmtp } from "@/lib/mailbox/smtp";

/**
 * Email through the CUSTOMER'S OWN mailbox: replies leave through their SMTP server from their own address, and incoming
 * mail is pulled over IMAP by the poller (lib/mailbox/imap.ts, Inngest cron every 3 minutes). Credentials (an app
 * password) live in the encrypted inbox config and are never returned by any API.
 */
export const imapEmailAdapter: ChannelAdapter = {
  channel: "email",
  provider: "imap",

  capabilities: () => ({
    supportsText: true,
    supportsTemplates: false,
    supportsMedia: false,
    supportsButtons: false,
    supportsOutbound: true,
    supportsInbound: true,
    hasSessionWindow: false,
    idempotentSend: false, // SMTP has no idempotency key: ambiguous failures are never retried blindly
    usageMetric: "emails",
  }),

  sessionWindow: () => ({ ...NO_WINDOW }),
  verifyWebhook: () => ({ ok: false }), // no webhook: inbound is polled
  parseInbound: () => [],

  async send(inbox, msg) {
    if (msg.content.kind !== "email") throw new ChannelError("UNSUPPORTED_CONTENT", "Email adapter only sends email content");
    const c = inbox.config as { smtp_host?: string; smtp_port?: number; username?: string; password?: string; from_name?: string };
    if (!c.smtp_host || !c.smtp_port || !c.username || !c.password) throw new ChannelError("NOT_CONNECTED", "Mailbox credentials are missing. Reconnect the mailbox.");
    const { html, unsubUrl } = decorateEmailHtml(msg.content.html, msg.contactId, msg.messageId);
    // thread the reply under the customer's last email when we have its Message-ID
    const last = await prisma.messages.findFirst({
      where: { org_id: inbox.org_id, contact_id: msg.contactId, inbox_id: inbox.id, direction: "inbound" },
      orderBy: { created_at: "desc" },
      select: { external_id: true },
    });
    const externalId = last?.external_id?.startsWith("<") ? last.external_id : undefined;
    const id = await sendViaSmtp(
      { smtp_host: c.smtp_host, smtp_port: Number(c.smtp_port), username: c.username, password: c.password },
      {
        from: inbox.identifier,
        fromName: c.from_name,
        to: msg.to,
        subject: msg.content.subject,
        html,
        text: msg.content.text,
        inReplyTo: externalId,
        headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }
    );
    return { externalId: id };
  },

  mapStatus: (): { status: MessageStatus } => ({ status: "sent" }),
};
