import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { uuid } from "../../../_shared/common";

type Params = { id: string };

export const GET = withAuth<Params>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  const notes = await prisma.notes.findMany({
    where: { org_id: session.org_id, contact_id: id },
    orderBy: { created_at: "desc" },
    include: { user: { select: { id: true, full_name: true } } },
  });
  return ok(notes);
});

export const POST = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const { body } = await parseBody(req, z.object({ body: z.string().trim().min(1).max(5000) }));
    const contact = await prisma.contacts.findFirst({ where: { id, org_id: session.org_id, is_active: true }, select: { id: true } });
    if (!contact) return fail("Contact not found", 404);
    const note = await prisma.notes.create({
      data: { org_id: session.org_id, contact_id: id, user_id: session.user.id, body },
      include: { user: { select: { id: true, full_name: true } } },
    });
    await audit(session, "note.create", "contact", id, { after: { note_id: note.id } });
    return ok(note, 201);
  },
  { role: "member" }
);
