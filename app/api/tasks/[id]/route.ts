import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { uuid } from "../../_shared/common";

type Params = { id: string };

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  due_at: z.coerce.date().nullable().optional(),
  done: z.boolean().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

export const PATCH = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const b = await parseBody(req, patchSchema);
    if (b.assigned_to) {
      const u = await prisma.users.findFirst({ where: { id: b.assigned_to, org_id: session.org_id, is_active: true }, select: { id: true } });
      if (!u) return fail("Assignee not found", 422);
    }
    const r = await prisma.tasks.updateMany({ where: { id, org_id: session.org_id }, data: b });
    if (!r.count) return fail("Task not found", 404);
    return ok({ id });
  },
  { role: "member" }
);

export const DELETE = withAuth<Params>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const r = await prisma.tasks.deleteMany({ where: { id, org_id: session.org_id } });
    if (!r.count) return fail("Task not found", 404);
    await audit(session, "task.delete", "task", id);
    return ok({ id });
  },
  { role: "member" }
);
