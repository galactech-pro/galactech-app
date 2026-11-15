import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { uuid } from "../../_shared/common";
import { audienceCount, audienceSchema, contentSchema, validateContent, type AudienceFilter, type CampaignContent } from "../_lib";

type Params = { id: string };

export const GET = withAuth<Params>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  const campaign = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
  if (!campaign) return fail("Campaign not found", 404);
  const audience_size = await audienceCount(session.org_id, campaign.channel, audienceSchema.parse(campaign.audience_filter));
  return ok({ ...campaign, audience_size });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  audience_filter: audienceSchema.optional(),
  content: contentSchema.optional(),
  template_id: z.string().nullable().optional(),
  scheduled_at: z.coerce.date().nullable().optional(),
});

export const PATCH = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const body = await parseBody(req, patchSchema);
    const c = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
    if (!c) return fail("Campaign not found", 404);
    if (c.status !== "draft" && c.status !== "scheduled") return fail("Only draft or scheduled campaigns can be edited", 409);

    const content = (body.content ?? c.content) as CampaignContent;
    const err = validateContent(c.channel, content);
    if (err) return fail(err, 422);
    if (body.scheduled_at && body.scheduled_at.getTime() < Date.now()) return fail("scheduled_at must be in the future", 422);

    const filter = (body.audience_filter ?? c.audience_filter) as AudienceFilter;
    const total = await audienceCount(session.org_id, c.channel, audienceSchema.parse(filter));
    // tenant-ok: id verified org-scoped by findFirst above
    const updated = await prisma.campaigns.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.audience_filter ? { audience_filter: body.audience_filter } : {}),
        ...(body.content ? { content: body.content } : {}),
        ...(body.template_id !== undefined ? { template_id: body.template_id } : {}),
        ...(body.scheduled_at !== undefined ? { scheduled_at: body.scheduled_at } : {}),
        stats: { ...(c.stats as Record<string, number>), total },
      },
    });
    await audit(session, "campaign.update", "campaign", id);
    return ok({ ...updated, audience_size: total });
  },
  { role: "member" }
);

export const DELETE = withAuth<Params>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const c = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
    if (!c) return fail("Campaign not found", 404);
    if (c.status !== "draft" && c.status !== "scheduled") return fail("Only draft or scheduled campaigns can be deleted", 409);
    // messages/deals reference the campaign; detach rather than lose history
    await prisma.$transaction([
      prisma.messages.updateMany({ where: { campaign_id: id, org_id: session.org_id }, data: { campaign_id: null } }),
      prisma.deals.updateMany({ where: { source_campaign_id: id, org_id: session.org_id }, data: { source_campaign_id: null } }),
      // tenant-ok: id verified org-scoped by findFirst above
      prisma.campaigns.delete({ where: { id } }),
    ]);
    await audit(session, "campaign.delete", "campaign", id, { before: { name: c.name } });
    return ok({ id, deleted: true });
  },
  { role: "member" }
);
