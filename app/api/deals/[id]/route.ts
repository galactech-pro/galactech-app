import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { uuid } from "../../_shared/common";
import { DEFAULT_PROBABILITY, STAGES } from "../../_shared/deals";

type Params = { id: string };

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  value_inr: z.coerce.number().min(0).max(1_000_000_000).optional(),
  stage: z.enum(STAGES).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** Edit a deal or move it between stages. Entering a stage sets its default probability and closes won/lost deals. */
export const PATCH = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const b = await parseBody(req, patchSchema);
    const deal = await prisma.deals.findFirst({ where: { id, org_id: session.org_id } });
    if (!deal) return fail("Deal not found", 404);
    if (b.assigned_to) {
      const u = await prisma.users.findFirst({ where: { id: b.assigned_to, org_id: session.org_id, is_active: true }, select: { id: true } });
      if (!u) return fail("Owner not found", 422);
    }
    const data: Record<string, unknown> = { ...b };
    if (b.stage && b.stage !== deal.stage) {
      if (b.probability === undefined) data.probability = DEFAULT_PROBABILITY[b.stage];
      data.closed_at = b.stage === "won" || b.stage === "lost" ? new Date() : null;
    }
    await prisma.deals.updateMany({ where: { id, org_id: session.org_id }, data });
    if (b.stage && b.stage !== deal.stage) {
      await audit(session, "deal.stage", "deal", id, { before: { stage: deal.stage }, after: { stage: b.stage } });
      if (b.stage === "won") await prisma.contacts.updateMany({ where: { id: deal.contact_id, org_id: session.org_id }, data: { status: "won" } });
    }
    return ok({ id });
  },
  { role: "member" }
);

export const DELETE = withAuth<Params>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const r = await prisma.deals.deleteMany({ where: { id, org_id: session.org_id } });
    if (!r.count) return fail("Deal not found", 404);
    await audit(session, "deal.delete", "deal", id);
    return ok({ id });
  },
  { role: "member" }
);
