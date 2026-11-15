import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { emitEvent } from "@/lib/channels/events";
import { clearCampaignLease } from "@/lib/channels/campaign-lease";
import { uuid } from "../../../_shared/common";

type Params = { id: string };

/**
 * paused -> sending (or scheduled if scheduled_at is still in the future). Atomic transition, then a new run is queued.
 * Stats are NOT reset; the worker skips contacts that already have a message for this campaign (idempotency key).
 */
export const POST = withAuth<Params>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const c = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
    if (!c) return fail("Campaign not found", 404);
    if (c.status !== "paused") return fail("Campaign is not paused", 409);
    const future = !!c.scheduled_at && c.scheduled_at.getTime() > Date.now();
    const res = await prisma.campaigns.updateMany({ where: { id, org_id: session.org_id, status: "paused" }, data: { status: future ? "scheduled" : "sending" } });
    if (res.count !== 1) return fail("Campaign is not paused", 409);
    await clearCampaignLease(session.org_id, id); // a stale lease from the paused run must not block the new run
    const queued = await emitEvent("campaign/send", { org_id: session.org_id, campaign_id: id }, `campaign-send-${id}-${Date.now()}`);
    if (!queued) {
      await prisma.campaigns.updateMany({ where: { id, org_id: session.org_id, status: { in: ["sending", "scheduled"] } }, data: { status: "paused" } });
      return fail("Could not queue the campaign. Please try again.", 503);
    }
    await audit(session, "campaign.resume", "campaign", id);
    return ok(await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } }));
  },
  { role: "member" }
);
