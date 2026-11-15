import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { uuid } from "../../../_shared/common";

type Params = { id: string };

export const POST = withAuth<Params>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const c = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
    if (!c) return fail("Campaign not found", 404);
    const copy = await prisma.campaigns.create({
      data: {
        org_id: session.org_id,
        name: `${c.name} (copy)`.slice(0, 200),
        channel: c.channel,
        type: c.type,
        status: "draft",
        audience_filter: c.audience_filter ?? {},
        template_id: c.template_id,
        content: c.content ?? {},
        stats: { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, converted: 0 },
        created_by: session.user.id,
      },
    });
    await audit(session, "campaign.duplicate", "campaign", copy.id, { after: { source: id } });
    return ok(copy, 201);
  },
  { role: "member" }
);
