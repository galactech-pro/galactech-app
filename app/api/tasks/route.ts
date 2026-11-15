import { z } from "zod";
import { withAuth, ok, parseQuery } from "@/lib/api";
import { prisma, type Prisma } from "@/lib/db";
import { pageSchema } from "../_shared/common";

const query = z.object({
  ...pageSchema,
  done: z.enum(["true", "false"]).optional(),
  assigned_to: z.string().optional(), // uuid | "me"
  contact_id: z.string().uuid().optional(),
  due: z.enum(["overdue", "today", "upcoming"]).optional(),
});

export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, query);
  const where: Prisma.tasksWhereInput = { org_id: session.org_id };
  if (q.done) where.done = q.done === "true";
  if (q.assigned_to) where.assigned_to = q.assigned_to === "me" ? session.user.id : q.assigned_to;
  if (q.contact_id) where.contact_id = q.contact_id;
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  if (q.due === "overdue") where.due_at = { lt: now };
  else if (q.due === "today") where.due_at = { gte: new Date(new Date(now).setHours(0, 0, 0, 0)), lte: endOfDay };
  else if (q.due === "upcoming") where.due_at = { gt: endOfDay };

  const [items, total] = await Promise.all([
    prisma.tasks.findMany({
      where,
      orderBy: [{ done: "asc" }, { due_at: "asc" }],
      skip: (q.page - 1) * q.page_size,
      take: q.page_size,
      include: {
        contact: { select: { id: true, full_name: true, phone: true } },
        assignee: { select: { id: true, full_name: true } },
      },
    }),
    prisma.tasks.count({ where }),
  ]);
  return ok({ items, total, page: q.page, page_size: q.page_size });
});
