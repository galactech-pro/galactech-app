import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { uuid } from "../../../_shared/common";

type Params = { id: string };

export const GET = withAuth<Params>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  const tasks = await prisma.tasks.findMany({
    where: { org_id: session.org_id, contact_id: id },
    orderBy: [{ done: "asc" }, { due_at: "asc" }],
  });
  return ok(tasks);
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  due_at: z.coerce.date().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
});

export const POST = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const body = await parseBody(req, createSchema);
    const contact = await prisma.contacts.findFirst({ where: { id, org_id: session.org_id, is_active: true }, select: { id: true } });
    if (!contact) return fail("Contact not found", 404);
    const assignee = body.assigned_to ?? session.user.id;
    const u = await prisma.users.findFirst({ where: { id: assignee, org_id: session.org_id, is_active: true }, select: { id: true } });
    if (!u) return fail("assigned_to user not found", 422);
    const task = await prisma.tasks.create({
      data: { org_id: session.org_id, contact_id: id, title: body.title, due_at: body.due_at ?? null, assigned_to: assignee, created_by: session.user.id },
    });
    await audit(session, "task.create", "task", task.id);
    return ok(task, 201);
  },
  { role: "member" }
);

const patchSchema = z.object({
  task_id: z.string().uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  due_at: z.coerce.date().nullable().optional(),
  done: z.boolean().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

export const PATCH = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const { task_id, ...data } = await parseBody(req, patchSchema);
    if (data.assigned_to) {
      const u = await prisma.users.findFirst({ where: { id: data.assigned_to, org_id: session.org_id, is_active: true }, select: { id: true } });
      if (!u) return fail("assigned_to user not found", 422);
    }
    const res = await prisma.tasks.updateMany({ where: { id: task_id, org_id: session.org_id, contact_id: id }, data });
    if (res.count === 0) return fail("Task not found", 404);
    await audit(session, "task.update", "task", task_id, { after: data as Record<string, string | boolean | null> as never });
    const task = await prisma.tasks.findFirst({ where: { id: task_id, org_id: session.org_id } });
    return ok(task);
  },
  { role: "member" }
);
