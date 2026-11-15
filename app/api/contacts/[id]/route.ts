import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEvent } from "@/lib/inngest";
import { normalizePhone } from "@/lib/utils";
import { contactStatusEnum, customFieldsSchema, uuid } from "../../_shared/common";

type Params = { id: string };

interface TimelineItem {
  type: "message" | "ai_call" | "note" | "task" | "deal" | "score";
  at: Date;
  data: Record<string, unknown>;
}

export const GET = withAuth<Params>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  const contact = await prisma.contacts.findFirst({
    where: { id, org_id: session.org_id, is_active: true },
    include: { assignee: { select: { id: true, full_name: true, email: true } } },
  });
  if (!contact) return fail("Contact not found", 404);

  const where = { org_id: session.org_id, contact_id: id };
  const [messages, calls, notes, tasks, deals, scores] = await Promise.all([
    prisma.messages.findMany({ where, orderBy: { created_at: "desc" }, take: 200 }),
    prisma.ai_calls.findMany({ where, orderBy: { created_at: "desc" }, take: 50 }),
    prisma.notes.findMany({ where, orderBy: { created_at: "desc" }, take: 100, include: { user: { select: { id: true, full_name: true } } } }),
    prisma.tasks.findMany({ where, orderBy: { created_at: "desc" }, take: 100 }),
    prisma.deals.findMany({ where, orderBy: { created_at: "desc" }, take: 50 }),
    prisma.score_history.findMany({ where, orderBy: { created_at: "desc" }, take: 50 }),
  ]);

  const timeline: TimelineItem[] = [
    ...messages.map((m) => ({ type: "message" as const, at: m.created_at, data: { ...m } })),
    ...calls.map((c) => ({ type: "ai_call" as const, at: c.created_at, data: { ...c, cost_inr: c.cost_inr?.toString() ?? null } })),
    ...notes.map((n) => ({ type: "note" as const, at: n.created_at, data: { ...n } })),
    ...tasks.map((t) => ({ type: "task" as const, at: t.created_at, data: { ...t } })),
    ...deals.map((d) => ({ type: "deal" as const, at: d.created_at, data: { ...d, value_inr: d.value_inr.toString() } })),
    ...scores.map((s) => ({ type: "score" as const, at: s.created_at, data: { ...s } })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return ok({
    contact,
    timeline,
    score_history: scores.slice().reverse(),
    tasks: tasks.filter((t) => !t.done),
    deals: deals.map((d) => ({ ...d, value_inr: d.value_inr.toString() })),
  });
});

const patchSchema = z.object({
  full_name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().min(5).optional(),
  email: z.string().email().nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  job_title: z.string().max(200).nullable().optional(),
  source: z.string().max(100).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(), // replace
  add_tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  remove_tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  custom_fields: customFieldsSchema.optional(), // merged into existing
  status: contactStatusEnum.optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  wa_opt_out: z.boolean().optional(),
  email_opt_out: z.boolean().optional(),
  dnc: z.boolean().optional(),
});

export const PATCH = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const body = await parseBody(req, patchSchema);
    const existing = await prisma.contacts.findFirst({ where: { id, org_id: session.org_id, is_active: true } });
    if (!existing) return fail("Contact not found", 404);

    const { tags, add_tags, remove_tags, custom_fields, phone, assigned_to, ...rest } = body;
    const data: Record<string, unknown> = { ...rest };

    if (phone !== undefined) {
      const norm = normalizePhone(phone);
      if (!norm) return fail("Invalid phone number", 422);
      if (norm !== existing.phone) {
        const clash = await prisma.contacts.findUnique({ where: { org_id_phone: { org_id: session.org_id, phone: norm } } });
        if (clash) return fail("Another contact already uses this phone number", 409, "DUPLICATE");
        data.phone = norm;
      }
    }
    if (assigned_to !== undefined) {
      if (assigned_to) {
        const u = await prisma.users.findFirst({ where: { id: assigned_to, org_id: session.org_id, is_active: true } });
        if (!u) return fail("assigned_to user not found", 422);
      }
      data.assigned_to = assigned_to;
    }

    let nextTags = existing.tags;
    if (tags) nextTags = [...new Set(tags)];
    if (add_tags) nextTags = [...new Set([...nextTags, ...add_tags])];
    if (remove_tags) nextTags = nextTags.filter((t) => !remove_tags.includes(t));
    if (tags || add_tags || remove_tags) data.tags = nextTags;
    const newTags = nextTags.filter((t) => !existing.tags.includes(t));

    if (custom_fields) {
      data.custom_fields = { ...(existing.custom_fields as Record<string, unknown>), ...custom_fields };
    }

    // tenant-ok: id verified org-scoped by findFirst above
    const updated = await prisma.contacts.update({ where: { id }, data });
    await audit(session, "contact.update", "contact", id, {
      before: { status: existing.status, tags: existing.tags, assigned_to: existing.assigned_to },
      after: { status: updated.status, tags: updated.tags, assigned_to: updated.assigned_to },
    });
    for (const tag of newTags) await sendEvent("contact/tag.added", { org_id: session.org_id, contact_id: id, tag });
    return ok(updated);
  },
  { role: "member" }
);

export const DELETE = withAuth<Params>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const res = await prisma.contacts.updateMany({ where: { id, org_id: session.org_id, is_active: true }, data: { is_active: false } });
    if (res.count === 0) return fail("Contact not found", 404);
    await audit(session, "contact.delete", "contact", id);
    return ok({ id, deleted: true });
  },
  { role: "member" }
);
