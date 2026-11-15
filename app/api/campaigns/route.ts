import { z } from "zod";
import { withAuth, ok, fail, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { pageSchema } from "../_shared/common";
import { anyChannelEnum, audienceCount, audienceSchema, channelEnum, contentSchema, validateContent } from "./_lib";

const listQuery = z.object({
  ...pageSchema,
  status: z.enum(["draft", "scheduled", "sending", "sent", "paused"]).optional(),
  channel: anyChannelEnum.optional(),
  q: z.string().trim().optional(),
});

export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, listQuery);
  const where = {
    org_id: session.org_id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.channel ? { channel: q.channel } : {}),
    ...(q.q ? { name: { contains: q.q, mode: "insensitive" as const } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.campaigns.findMany({ where, orderBy: { created_at: "desc" }, skip: (q.page - 1) * q.page_size, take: q.page_size }),
    prisma.campaigns.count({ where }),
  ]);
  return ok({ items, total, page: q.page, page_size: q.page_size });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: channelEnum,
  type: z.enum(["broadcast", "sequence"]).default("broadcast"),
  audience_filter: audienceSchema,
  content: contentSchema,
  template_id: z.string().optional().nullable(),
  scheduled_at: z.coerce.date().optional().nullable(),
});

export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, createSchema);
    const err = validateContent(body.channel, body.content);
    if (err) return fail(err, 422);
    if (body.scheduled_at && body.scheduled_at.getTime() < Date.now()) return fail("scheduled_at must be in the future", 422);

    const audience_size = await audienceCount(session.org_id, body.channel, body.audience_filter);
    const campaign = await prisma.campaigns.create({
      data: {
        org_id: session.org_id,
        name: body.name,
        channel: body.channel,
        type: body.type,
        audience_filter: body.audience_filter,
        content: body.content,
        template_id: body.template_id ?? null,
        scheduled_at: body.scheduled_at ?? null,
        stats: { total: audience_size, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, converted: 0 },
        created_by: session.user.id,
      },
    });
    await audit(session, "campaign.create", "campaign", campaign.id, { after: { name: campaign.name, channel: campaign.channel } });
    return ok({ ...campaign, audience_size }, 201);
  },
  { role: "member" }
);
