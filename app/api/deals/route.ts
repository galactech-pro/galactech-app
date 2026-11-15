import { z } from "zod";
import { withAuth, ok, fail, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

import { DEFAULT_PROBABILITY, STAGES } from "../_shared/deals";
const stageEnum = z.enum(STAGES);

const listQuery = z.object({
  assigned_to: z.string().optional(), // uuid | "me"
  q: z.string().trim().max(100).optional(),
});

/** All deals of the org with contact + owner, for the pipeline board (capped at 500, newest first). */
export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, listQuery);
  const assigned = q.assigned_to === "me" ? session.user.id : q.assigned_to && z.string().uuid().safeParse(q.assigned_to).success ? q.assigned_to : undefined;
  const deals = await prisma.deals.findMany({
    where: {
      org_id: session.org_id,
      ...(assigned ? { assigned_to: assigned } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: "insensitive" } }, { contact: { full_name: { contains: q.q, mode: "insensitive" } } }] } : {}),
    },
    orderBy: { created_at: "desc" },
    take: 500,
    include: {
      contact: { select: { id: true, full_name: true, company: true } },
      assignee: { select: { id: true, full_name: true, email: true } },
    },
  });
  return ok(deals.map((d) => ({ ...d, value_inr: d.value_inr.toString() })));
});

const createSchema = z.object({
  contact_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  value_inr: z.coerce.number().min(0).max(1_000_000_000).default(0),
  stage: stageEnum.default("lead"),
  assigned_to: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const POST = withAuth(
  async (req, session) => {
    const b = await parseBody(req, createSchema);
    const contact = await prisma.contacts.findFirst({ where: { id: b.contact_id, org_id: session.org_id, is_active: true }, select: { id: true } });
    if (!contact) return fail("Contact not found", 404);
    const owner = b.assigned_to ?? session.user.id;
    const u = await prisma.users.findFirst({ where: { id: owner, org_id: session.org_id, is_active: true }, select: { id: true } });
    if (!u) return fail("Owner not found", 422);
    const deal = await prisma.deals.create({
      data: {
        org_id: session.org_id,
        contact_id: contact.id,
        title: b.title,
        value_inr: b.value_inr,
        stage: b.stage,
        probability: DEFAULT_PROBABILITY[b.stage],
        assigned_to: owner,
        notes: b.notes ?? null,
        closed_at: b.stage === "won" || b.stage === "lost" ? new Date() : null,
      },
    });
    await audit(session, "deal.create", "deal", deal.id, { after: { title: deal.title, stage: deal.stage } });
    return ok({ ...deal, value_inr: deal.value_inr.toString() }, 201);
  },
  { role: "member" }
);
