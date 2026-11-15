import { z } from "zod";
import { withAuth, ok, fail, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const listQuery = z.object({
  scope: z.enum(["mine", "all"]).default("mine"),
  status: z.enum(["open", "done"]).default("open"),
});

/** The org-wide task list (the per-contact list lives under /api/contacts/[id]/tasks). */
export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, listQuery);
  const tasks = await prisma.tasks.findMany({
    where: { org_id: session.org_id, done: q.status === "done", ...(q.scope === "mine" ? { assigned_to: session.user.id } : {}) },
    orderBy: q.status === "done" ? { created_at: "desc" } : [{ due_at: { sort: "asc", nulls: "last" } }, { created_at: "desc" }],
    take: 300,
    include: {
      contact: { select: { id: true, full_name: true } },
      assignee: { select: { id: true, full_name: true, email: true } },
    },
  });
  return ok(tasks);
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  due_at: z.coerce.date().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

export const POST = withAuth(
  async (req, session) => {
    const b = await parseBody(req, createSchema);
    if (b.contact_id) {
      const c = await prisma.contacts.findFirst({ where: { id: b.contact_id, org_id: session.org_id, is_active: true }, select: { id: true } });
      if (!c) return fail("Contact not found", 404);
    }
    const owner = b.assigned_to ?? session.user.id;
    const u = await prisma.users.findFirst({ where: { id: owner, org_id: session.org_id, is_active: true }, select: { id: true } });
    if (!u) return fail("Assignee not found", 422);
    const task = await prisma.tasks.create({
      data: { org_id: session.org_id, contact_id: b.contact_id ?? null, title: b.title, due_at: b.due_at ?? null, assigned_to: owner, created_by: session.user.id },
    });
    await audit(session, "task.create", "task", task.id);
    return ok(task, 201);
  },
  { role: "member" }
);
