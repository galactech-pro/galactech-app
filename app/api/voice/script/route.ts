import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { generateCallScript } from "@/lib/ai";

/** Preview the AI call script for a contact without placing a call. */
export const POST = withAuth(
  async (req, session) => {
    const { contactId } = await parseBody(req, z.object({ contactId: z.string().uuid() }));
    const [contact, org] = await Promise.all([
      prisma.contacts.findFirst({ where: { id: contactId, org_id: session.org_id, is_active: true } }),
      prisma.organisations.findUnique({ where: { id: session.org_id } }),
    ]);
    if (!contact || !org) return fail("Contact not found", 404);
    return ok(await generateCallScript(contact, org));
  },
  { role: "member" }
);
