import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { answerCustomer } from "@/lib/knowledge/answer";

const schema = z.object({
  contactId: z.string().uuid(),
  goal: z.string().trim().max(500).optional(),
  tone: z.enum(["professional", "friendly", "urgent"]).default("friendly"),
});

/** Suggests a reply to the contact's latest inbound message. Does not send. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    const contact = await prisma.contacts.findFirst({ where: { id: body.contactId, org_id: session.org_id, is_active: true } });
    if (!contact) return fail("Contact not found", 404);
    const recent = await prisma.messages.findMany({
      where: { org_id: session.org_id, contact_id: contact.id },
      orderBy: { created_at: "desc" },
      take: 12,
    });
    // The thread is untrusted: passed as `conversation`, never pasted into `goal`.
    const conversation = recent.reverse().map((m) => ({ direction: m.direction, text: m.content }));
    const channel = recent.some((m) => m.channel === "email") && recent[recent.length - 1]?.channel === "email" ? "email" : "chat";
    const ans = await answerCustomer({
      orgId: session.org_id,
      contact: { name: contact.full_name, email: contact.email, phone: contact.phone, company: contact.company },
      channel,
      conversation,
      instruction: body.goal,
    });
    const res = {
      message: ans.reply,
      alternatives: [] as string[],
      needs_info: ans.reply ? [] : ans.missing.length ? ans.missing : ["the knowledge base does not cover this yet"],
      warnings: ans.status === "partial" ? ["The knowledge base only covers part of this. Check the reply before sending."] : ans.usesPrivate ? ["Uses private knowledge. Check before sending."] : [],
      status: ans.status,
      sources: ans.sources,
    };
    return ok(res);
  },
  { role: "member" }
);
