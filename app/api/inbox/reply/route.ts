import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { renderSimple } from "@/lib/email";
import { conversationForContact } from "@/lib/channels/conversations";
import { toApiError } from "@/lib/channels/errors";
import { sendOutbound } from "@/lib/channels/outbound";
import type { OutboundContent } from "@/lib/channels/types";

const schema = z
  .object({
    conversationId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    text: z.string().trim().min(1).max(4096).optional(),
    subject: z.string().trim().max(300).optional(), // email replies
    template_name: z.string().min(1).optional(),
    template_params: z.array(z.string()).default([]),
    template_language: z.string().max(16).optional(),
    /** client-generated id: a double click / network retry with the same id cannot send twice */
    client_id: z.string().min(8).max(100).optional(),
  })
  .refine((b) => b.conversationId || b.contactId, { message: "Provide conversationId or contactId" })
  .refine((b) => b.text || b.template_name, { message: "Provide text or template_name" });

/**
 * Agent reply, through the shared outbound pipeline (compliance, WhatsApp session-window/template rule, atomic limits,
 * outbox). Outside the 24h window free text answers 422 SESSION_WINDOW_EXPIRED and the UI sends a template instead.
 */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    const orgId = session.org_id;

    let convId = body.conversationId;
    if (!convId) convId = (await conversationForContact(orgId, body.contactId as string)).id;
    const conv = await prisma.conversations.findFirst({
      where: { id: convId, org_id: orgId },
      include: { inbox: { select: { id: true, channel: true } }, contact: { select: { id: true, is_active: true } } },
    });
    if (!conv || !conv.contact.is_active) return fail("Conversation not found", 404);
    if (conv.inbox.channel === "voice") return fail("Voice conversations are read-only", 422, "CHANNEL_NOT_SUPPORTED");

    let content: OutboundContent;
    if (body.template_name) {
      content = { kind: "template", name: body.template_name, params: body.template_params, language: body.template_language };
    } else if (conv.inbox.channel === "email") {
      const subject = body.subject || "Re: your message";
      content = { kind: "email", subject, html: await renderSimple(subject, (body.text as string).split(/\n+/).filter(Boolean)), text: body.text };
    } else {
      content = { kind: "text", text: body.text as string };
    }

    try {
      const r = await sendOutbound({
        orgId,
        contactId: conv.contact.id,
        channel: conv.inbox.channel,
        inboxId: conv.inbox.id,
        content,
        purpose: "service",
        automated: false,
        idempotencyKey: body.client_id ? `reply:${session.user.id}:${body.client_id}` : `reply:${randomUUID()}`,
      });
      await prisma.conversations.updateMany({ where: { id: conv.id, org_id: orgId }, data: { unread_count: 0 } });
      await audit(session, "inbox.reply", "contact", conv.contact.id, { after: { message_id: r.message.id, state: r.state } });
      return ok({ messageId: r.message.id, state: r.state, conversationId: conv.id, message: r.message }, 201);
    } catch (e) {
      throw toApiError(e, "Send"); // ComplianceError/OutboundError -> ApiError(422, code); PlanLimitError passes through
    }
  },
  { role: "member" }
);
