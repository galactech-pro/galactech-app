import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { clearCampaignLease } from "@/lib/channels/campaign-lease";
import { uuid } from "../../../_shared/common";

type Params = { id: string };

/** sending|scheduled -> paused. The send worker must re-check campaign.status between batches. */
export const POST = withAuth<Params>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const res = await prisma.campaigns.updateMany({
      where: { id, org_id: session.org_id, status: { in: ["sending", "scheduled"] } },
      data: { status: "paused" },
    });
    if (res.count === 0) return fail("Only sending or scheduled campaigns can be paused", 409);
    await clearCampaignLease(session.org_id, id); // the running worker loses its heartbeat and stops after its current batch
    await audit(session, "campaign.pause", "campaign", id);
    return ok(await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } }));
  },
  { role: "member" }
);
