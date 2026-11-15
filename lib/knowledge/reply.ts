import { prisma } from "@/lib/db";
import { answerCustomer } from "./answer";
import { createDraft, draftWarnings } from "@/lib/ai/drafts";
import { sendOutbound } from "@/lib/channels/outbound";
import { renderSimple } from "@/lib/email";
import { replySubjectFor } from "@/lib/email/inbound";
import { recordGap } from "./index";

export type AutoReplyResult =
  | { action: "skipped"; reason: string }
  | { action: "drafted"; draftId: string }
  | { action: "sent" }
  | { action: "handoff"; reason: string };

const REPLY_CHANNELS = new Set(["whatsapp", "email", "telegram", "webchat", "sms", "instagram", "messenger"]);

/**
 * Answer a customer's latest inbound message from the knowledge base.
 * off   : nothing.
 * draft : a pending ai_drafts row a teammate approves in /drafts (default, safest).
 * auto  : sent immediately, but ONLY when retrieval found sources, the reply passes the grounding guards with zero
 *         warnings, and we haven't already auto-replied 3 times in 10 minutes. Anything else falls back to a draft or a human.
 * Every unanswerable question is logged as a knowledge gap so a human answers it once and the KB grows.
 */
export async function autoReplyToMessage(orgId: string, contactId: string, messageId: string): Promise<AutoReplyResult> {
  const org = await prisma.organisations.findUnique({
    where: { id: orgId },
    select: { name: true, auto_reply_mode: true, business_summary: true, handoff_message: true },
  });
  if (!org || org.auto_reply_mode === "off") return { action: "skipped", reason: "auto-reply is off" };

  const msg = await prisma.messages.findFirst({ where: { id: messageId, org_id: orgId, contact_id: contactId, direction: "inbound" } });
  if (!msg || !REPLY_CHANNELS.has(msg.channel)) return { action: "skipped", reason: "channel not supported" };
  if (msg.content.trim().length < 3 || /^\s*(stop|unsubscribe|cancel|start)\s*$/i.test(msg.content)) return { action: "skipped", reason: "keyword message" };

  const contact = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId, is_active: true } });
  if (!contact) return { action: "skipped", reason: "contact missing" };

  // Loop / runaway guard: too many automated answers lately means a human should look.
  const recentOut = await prisma.messages.count({
    where: { org_id: orgId, contact_id: contactId, direction: "outbound", created_at: { gte: new Date(Date.now() - 10 * 60_000) } },
  });
  if (recentOut >= 3) return { action: "handoff", reason: "several replies already sent recently" };

  const recent = await prisma.messages.findMany({ where: { org_id: orgId, contact_id: contactId }, orderBy: { created_at: "desc" }, take: 12 });
  const conversation = recent.reverse().map((m) => ({ direction: m.direction, text: m.content }));

  let ans;
  try {
    ans = await answerCustomer({ orgId, contact: { name: contact.full_name, email: contact.email, phone: contact.phone, company: contact.company }, channel: msg.channel === "email" ? "email" : "chat", conversation });
  } catch (e) {
    console.error("[kb-auto-reply] answer failed", e);
    return { action: "skipped", reason: "ai unavailable" };
  }

  if (ans.status === "unknown" || !ans.reply.trim()) {
    await recordGap(orgId, msg.content, msg.conversation_id);
    return handoff(orgId, contactId, msg, org.handoff_message, "answer not in knowledge");
  }
  if (ans.status === "partial") await recordGap(orgId, msg.content, msg.conversation_id);

  const res = { message: ans.reply };
  const sources = ans.sources;
  const usesPrivate = ans.usesPrivate;
  const context = { origin: "inbox" as const, facts: ans.facts, dedupe_key: `kb:${msg.id}`, note: (usesPrivate ? "Uses private knowledge, review before sending. " : "") + (ans.status === "partial" ? "Partly answered, a teammate should confirm the rest. " : "") + (sources.length ? `Sources: ${sources.join(", ")}` : "Source: your text/FAQ knowledge") };
  const warnings = draftWarnings(context, res.message);

  // Private knowledge (confirmed sensitive uploads) is never sent without a person reading the reply first.
  if (org.auto_reply_mode === "auto" && warnings.length === 0 && !usesPrivate) {
    const subject = msg.channel === "email" ? await replySubjectFor(orgId, contactId) : "Re: your message";
    try {
      await sendOutbound({
        orgId,
        contactId,
        channel: msg.channel,
        inboxId: msg.inbox_id ?? undefined,
        content:
          msg.channel === "email"
            ? { kind: "email", subject, html: await renderSimple(subject, res.message.split(/\n+/).filter(Boolean)), text: res.message }
            : { kind: "text", text: res.message },
        purpose: "service",
        automated: true,
        idempotencyKey: `kbauto:${msg.id}`,
      });
      return { action: "sent" };
    } catch (e) {
      // Compliance refusal (opt-out, closed WhatsApp window...) or provider error: leave it for a human via a draft.
      console.error("[kb-auto-reply] send failed, drafting instead", e);
    }
  }

  const d = await createDraft({ orgId, contactId, channel: msg.channel, subject: msg.channel === "email" ? await replySubjectFor(orgId, contactId) : null, body: res.message, context });
  return { action: "drafted", draftId: d.id };
}

/** Cannot answer: optionally tell the customer a person will follow up, and mark the conversation for attention. */
async function handoff(
  orgId: string,
  contactId: string,
  msg: { id: string; channel: import("@prisma/client").channel; inbox_id: string | null; conversation_id: string | null },
  handoffMessage: string | null,
  reason: string
): Promise<AutoReplyResult> {
  if (msg.conversation_id) {
    await prisma.conversations.updateMany({ where: { id: msg.conversation_id, org_id: orgId }, data: { status: "open", assignee_id: null } });
  }
  const text = handoffMessage?.trim();
  if (text && msg.channel !== "email") {
    try {
      await sendOutbound({
        orgId,
        contactId,
        channel: msg.channel,
        inboxId: msg.inbox_id ?? undefined,
        content: { kind: "text", text },
        purpose: "service",
        automated: true,
        idempotencyKey: `kbhandoff:${msg.id}`,
      });
    } catch (e) {
      console.error("[kb-auto-reply] handoff message failed", e);
    }
  }
  return { action: "handoff", reason };
}
