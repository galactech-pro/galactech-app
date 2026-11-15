import { z } from "zod";
import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkLimit } from "@/lib/limits";
import { audit } from "@/lib/audit";
import { emitEvent } from "@/lib/channels/events";
import { uuid } from "../../../_shared/common";
import { audienceCount, audienceSchema, audienceWhere, contentSchema, metricFor, validateContent, type CampaignContent } from "../../_lib";

type Params = { id: string };

/** Body (optional): { scheduled_at?: ISO date } — overrides campaign.scheduled_at. Future date => status 'scheduled'. */
export const POST = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const raw = await req.text();
    let json: unknown = {};
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        return fail("Invalid JSON body", 400);
      }
    }
    const body = z.object({ scheduled_at: z.coerce.date().nullable().optional() }).parse(json);

    const c = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
    if (!c) return fail("Campaign not found", 404);
    if (c.status === "sent" || c.status === "sending") return fail("Campaign has already been sent", 409, "ALREADY_SENT");
    if (c.status === "paused") return fail("Campaign is paused — use resume", 409);

    const content = contentSchema.parse(c.content) as CampaignContent;
    const err = validateContent(c.channel, content);
    if (err) return fail(err, 422);

    const filter = audienceSchema.parse(c.audience_filter);
    const size = await audienceCount(session.org_id, c.channel, filter);
    if (size === 0) return fail("Audience is empty after excluding opted-out / DNC contacts", 422, "EMPTY_AUDIENCE");
    const metric = metricFor(c.channel);
    if (metric) await checkLimit(session.org_id, metric, size); // advisory preflight; each send reserves atomically

    // H-04: free-form WhatsApp text only reaches contacts inside the 24h window. Without a template, refuse to start a
    // campaign that would just fail (and be recorded as failed) for everyone outside the window.
    if (c.channel === "whatsapp" && !content.template_name) {
      const cold = await prisma.contacts.count({
        where: {
          AND: [
            audienceWhere(session.org_id, c.channel, filter),
            { messages: { none: { org_id: session.org_id, channel: "whatsapp", direction: "inbound", created_at: { gt: new Date(Date.now() - 24 * 3600 * 1000) } } } },
          ],
        },
      });
      if (cold > 0) {
        return fail(
          `${cold} of ${size} contacts have not messaged you in the last 24 hours. WhatsApp only allows an approved template for them — add a template to this campaign.`,
          422,
          "TEMPLATE_REQUIRED"
        );
      }
    }

    const scheduledAt = body.scheduled_at !== undefined ? body.scheduled_at : c.scheduled_at;
    const isScheduled = !!scheduledAt && scheduledAt.getTime() > Date.now() + 30_000;

    // Atomic claim: only one request can move draft/scheduled -> sending/scheduled (double click, concurrent tabs).
    const claimed = await prisma.campaigns.updateMany({
      where: { id, org_id: session.org_id, status: { in: ["draft", "scheduled"] } },
      data: {
        status: isScheduled ? "scheduled" : "sending",
        scheduled_at: isScheduled ? scheduledAt : null,
        stats: { ...(c.stats as Record<string, number>), total: size },
      },
    });
    if (claimed.count !== 1) return fail("Campaign has already been sent", 409, "ALREADY_SENT");

    // Worker reads campaigns.scheduled_at: if set and in the future it sleeps until then. Unique event id per run.
    const queued = await emitEvent("campaign/send", { org_id: session.org_id, campaign_id: id }, `campaign-send-${id}-${Date.now()}`);
    if (!queued) {
      await prisma.campaigns.updateMany({ where: { id, org_id: session.org_id, status: { in: ["sending", "scheduled"] } }, data: { status: c.status } });
      return fail("Could not queue the campaign. Please try again.", 503);
    }
    await audit(session, isScheduled ? "campaign.schedule" : "campaign.send", "campaign", id, { after: { audience: size } });
    const updated = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
    return ok({ campaign: updated, audience_size: size });
  },
  { role: "member" }
);
