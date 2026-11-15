import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkLimit } from "@/lib/limits";
import { initiateCall } from "@/lib/voice";
import { audit } from "@/lib/audit";

const schema = z.object({
  contactId: z.string().uuid(),
  customScript: z.string().max(8000).optional(),
  scheduledAt: z.coerce.date().optional(),
  voiceId: z.string().optional(), // accepted; lib/voice.initiateCall contract has no voice param (org voice is used)
});

export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    const contact = await prisma.contacts.findFirst({ where: { id: body.contactId, org_id: session.org_id, is_active: true } });
    if (!contact) return fail("Contact not found", 404);
    if (contact.dnc) return fail("Contact is on the Do-Not-Call list", 422, "DNC");

    if (body.scheduledAt && body.scheduledAt.getTime() > Date.now() + 60_000) {
      await checkLimit(session.org_id, "ai_calls");
      const row = await prisma.ai_calls.create({
        data: { org_id: session.org_id, contact_id: contact.id, to_number: contact.phone, status: "initiated", scheduled_at: body.scheduledAt },
      });
      await audit(session, "voice.schedule", "ai_call", row.id, { after: { scheduled_at: body.scheduledAt.toISOString() } });
      return ok({ aiCallId: row.id, scheduled: true, scheduled_at: body.scheduledAt }, 201);
    }

    // initiateCall checks dnc + limit and persists the ai_calls row.
    const res = await initiateCall(session.org_id, contact.id, body.customScript);
    await audit(session, "voice.call", "ai_call", res.aiCallId);
    return ok({ ...res, scheduled: false }, 201);
  },
  { role: "member" }
);
