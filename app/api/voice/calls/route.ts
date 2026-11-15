import { z } from "zod";
import { withAuth, ok, parseQuery } from "@/lib/api";
import { prisma, type Prisma } from "@/lib/db";
import { currentMonth } from "@/lib/limits";
import { pageSchema } from "../../_shared/common";

const query = z.object({
  ...pageSchema,
  outcome: z.enum(["interested", "callback", "not_interested", "no_answer", "voicemail"]).optional(),
  status: z.enum(["initiated", "ringing", "in_progress", "completed", "failed", "no_answer"]).optional(),
  contact_id: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, query);
  const org = session.org_id;
  const where: Prisma.ai_callsWhereInput = {
    org_id: org,
    ...(q.outcome ? { outcome: q.outcome } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.contact_id ? { contact_id: q.contact_id } : {}),
    ...(q.from || q.to ? { created_at: { gte: q.from, lte: q.to } } : {}),
  };
  const monthStart = currentMonth();

  const [items, total, allCount, answered, agg, month, usage, limits] = await Promise.all([
    prisma.ai_calls.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (q.page - 1) * q.page_size,
      take: q.page_size,
      include: { contact: { select: { id: true, full_name: true, phone: true } } },
    }),
    prisma.ai_calls.count({ where }),
    prisma.ai_calls.count({ where: { org_id: org } }),
    prisma.ai_calls.count({ where: { org_id: org, status: "completed", duration_seconds: { gt: 0 } } }),
    prisma.ai_calls.aggregate({
      where: { org_id: org, status: "completed" },
      _avg: { duration_seconds: true },
      _sum: { cost_inr: true },
    }),
    prisma.ai_calls.aggregate({ where: { org_id: org, created_at: { gte: monthStart } }, _count: true, _sum: { cost_inr: true } }),
    prisma.usage.findUnique({ where: { org_id_month: { org_id: org, month: monthStart } } }),
    prisma.organisations.findUnique({ where: { id: org }, select: { plan: true } }).then((o) => (o ? prisma.plan_limits.findUnique({ where: { plan: o.plan } }) : null)),
  ]);

  return ok({
    items: items.map((c) => ({ ...c, cost_inr: c.cost_inr?.toString() ?? null })),
    total,
    page: q.page,
    page_size: q.page_size,
    stats: {
      total_calls: allCount,
      answer_rate: allCount ? Math.round((answered / allCount) * 1000) / 10 : 0, // percent
      avg_duration_seconds: Math.round(agg._avg.duration_seconds ?? 0),
      calls_this_month: month._count,
      calls_limit: limits?.max_ai_calls_mo ?? null,
      calls_used_metered: usage?.ai_calls_made ?? 0,
      cost_total_inr: agg._sum.cost_inr?.toString() ?? "0",
      cost_this_month_inr: month._sum.cost_inr?.toString() ?? "0",
    },
  });
});
