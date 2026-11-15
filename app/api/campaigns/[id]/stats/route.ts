import { z } from "zod";
import { withAuth, ok, fail, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { pageSchema, uuid } from "../../../_shared/common";

type Params = { id: string };
const query = z.object({ ...pageSchema, page_size: z.coerce.number().int().min(1).max(200).default(50), status: z.enum(["queued", "sent", "delivered", "read", "failed"]).optional() });

export const GET = withAuth<Params>(async (req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  const q = parseQuery(req, query);
  const c = await prisma.campaigns.findFirst({ where: { id, org_id: session.org_id } });
  if (!c) return fail("Campaign not found", 404);

  const base = { org_id: session.org_id, campaign_id: id, direction: "outbound" as const };
  const [total, sent, delivered, read, failed, opened, clicked, replied, dealsAll, dealsWon, wonAgg] = await Promise.all([
    prisma.messages.count({ where: base }),
    prisma.messages.count({ where: { ...base, status: { in: ["sent", "delivered", "read"] } } }),
    prisma.messages.count({ where: { ...base, status: { in: ["delivered", "read"] } } }),
    prisma.messages.count({ where: { ...base, status: "read" } }),
    prisma.messages.count({ where: { ...base, status: "failed" } }),
    prisma.messages.count({ where: { ...base, OR: [{ opened_at: { not: null } }, { status: "read" }] } }),
    prisma.messages.count({ where: { ...base, clicked_at: { not: null } } }),
    prisma.messages.count({ where: { ...base, replied_at: { not: null } } }),
    prisma.deals.count({ where: { org_id: session.org_id, source_campaign_id: id } }),
    prisma.deals.count({ where: { org_id: session.org_id, source_campaign_id: id, stage: "won" } }),
    prisma.deals.aggregate({ where: { org_id: session.org_id, source_campaign_id: id, stage: "won" }, _sum: { value_inr: true } }),
  ]);

  const logWhere = { ...base, ...(q.status ? { status: q.status } : {}) };
  const [log, logTotal] = await Promise.all([
    prisma.messages.findMany({
      where: logWhere,
      orderBy: { created_at: "desc" },
      skip: (q.page - 1) * q.page_size,
      take: q.page_size,
      select: {
        id: true, status: true, error: true, sent_at: true, opened_at: true, clicked_at: true, replied_at: true, created_at: true,
        contact: { select: { id: true, full_name: true, phone: true, email: true } },
      },
    }),
    prisma.messages.count({ where: logWhere }),
  ]);

  return ok({
    campaign: { id: c.id, name: c.name, channel: c.channel, status: c.status, scheduled_at: c.scheduled_at, sent_at: c.sent_at },
    audience_total: (c.stats as { total?: number }).total ?? total,
    totals: { queued_or_total: total, sent, delivered, opened, clicked, replied, failed, converted: dealsWon, deals: dealsAll, read, revenue_inr: wonAgg._sum.value_inr?.toString() ?? "0" },
    log: { items: log, total: logTotal, page: q.page, page_size: q.page_size },
  });
});
