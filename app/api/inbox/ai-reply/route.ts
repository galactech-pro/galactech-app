import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { generateMessage } from "@/lib/ai";

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
      take: 6,
    });
    // The thread is untrusted: passed as `conversation`, never pasted into `goal`.
    const conversation = recent.reverse().map((m) => ({ direction: m.direction, text: m.content }));
    const goal = body.goal ?? "Write a helpful reply to the customer's latest message.";
    const industry = (contact.custom_fields as Record<string, unknown> | null)?.industry;
    const res = await generateMessage({
      goal,
      contact: { name: contact.full_name, company: contact.company ?? undefined, industry: typeof industry === "string" ? industry : undefined },
      channel: "whatsapp",
      tone: body.tone,
      orgId: session.org_id,
      conversation,
      resolveTags: true,
    });
    return ok(res);
  },
  { role: "member" }
);
