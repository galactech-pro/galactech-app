import { z } from "zod";
import { withAuth, ok, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";

const Q = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().max(100).optional(),
  entity_type: z.string().max(100).optional(),
});

/** GET /api/settings/audit?page&page_size&action&entity_type → {items,total,page,page_size} */
export const GET = withAuth(
  async (req, session) => {
    const q = parseQuery(req, Q);
    const where = {
      org_id: session.org_id,
      ...(q.action ? { action: { contains: q.action } } : {}),
      ...(q.entity_type ? { entity_type: q.entity_type } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.audit_log.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (q.page - 1) * q.page_size,
        take: q.page_size,
        include: { user: { select: { email: true, full_name: true } } },
      }),
      prisma.audit_log.count({ where }),
    ]);
    return ok({ items, total, page: q.page, page_size: q.page_size });
  },
  { role: "admin" }
);
