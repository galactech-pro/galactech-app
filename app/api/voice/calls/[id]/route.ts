import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { uuid } from "../../../_shared/common";

type Params = { id: string };

export const GET = withAuth<Params>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  const call = await prisma.ai_calls.findFirst({
    where: { id, org_id: session.org_id },
    include: { contact: { select: { id: true, full_name: true, phone: true, company: true, lead_score: true } } },
  });
  if (!call) return fail("Call not found", 404);
  return ok({ ...call, cost_inr: call.cost_inr?.toString() ?? null });
});
