import { z } from "zod";
import { withAuth, ok, fail, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkLimit, incrementUsage } from "@/lib/limits";
import { normalizePhone } from "@/lib/utils";
import { audit } from "@/lib/audit";
import { sendEvent } from "@/lib/inngest";
import { buildContactWhere, contactStatusEnum, customFieldsSchema, pageSchema } from "../_shared/common";

const listQuery = z.object({
  ...pageSchema,
  q: z.string().trim().optional(),
  tags: z.string().optional(), // comma separated
  score_min: z.coerce.number().int().min(1).max(10).optional(),
  score_max: z.coerce.number().int().min(1).max(10).optional(),
  status: z.string().optional(), // comma separated
  assigned_to: z.string().optional(), // uuid | "me"
  contacted_within_days: z.coerce.number().int().min(1).optional(),
  inactive_days: z.coerce.number().int().min(1).optional(),
  opt_out: z.enum(["wa", "email", "dnc", "any"]).optional(),
  sort: z.enum(["created_at", "updated_at", "lead_score", "full_name", "last_contacted_at"]).default("created_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const csv = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, listQuery);
  const statuses = csv(q.status);
  if (statuses) z.array(contactStatusEnum).parse(statuses);
  const where = buildContactWhere(session.org_id, {
    q: q.q,
    tags: csv(q.tags),
    score_min: q.score_min,
    score_max: q.score_max,
    status: statuses,
    assigned_to: q.assigned_to === "me" ? session.user.id : q.assigned_to,
    contacted_within_days: q.contacted_within_days,
    inactive_days: q.inactive_days,
    opt_out: q.opt_out,
  });
  const [items, total] = await Promise.all([
    prisma.contacts.findMany({
      where,
      orderBy: { [q.sort]: q.dir },
      skip: (q.page - 1) * q.page_size,
      take: q.page_size,
      include: { assignee: { select: { id: true, full_name: true, email: true } } },
    }),
    prisma.contacts.count({ where }),
  ]);
  return ok({ items, total, page: q.page, page_size: q.page_size });
});

const createSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  phone: z.string().min(5),
  email: z.string().email().optional().nullable(),
  company: z.string().max(200).optional().nullable(),
  job_title: z.string().max(200).optional().nullable(),
  source: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
  status: contactStatusEnum.optional(),
  assigned_to: z.string().uuid().optional().nullable(),
  custom_fields: customFieldsSchema.optional(),
});

export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, createSchema);
    const phone = normalizePhone(body.phone);
    if (!phone) return fail("Invalid phone number", 422);
    const tags = [...new Set(body.tags)];

    const existing = await prisma.contacts.findUnique({ where: { org_id_phone: { org_id: session.org_id, phone } } });
    if (existing?.is_active) return fail("A contact with this phone number already exists", 409, "DUPLICATE");

    if (body.assigned_to) {
      const u = await prisma.users.findFirst({ where: { id: body.assigned_to, org_id: session.org_id, is_active: true } });
      if (!u) return fail("assigned_to user not found", 422);
    }

    await checkLimit(session.org_id, "contacts");
    const data = {
      full_name: body.full_name,
      email: body.email ?? null,
      company: body.company ?? null,
      job_title: body.job_title ?? null,
      source: body.source ?? "manual",
      tags,
      status: body.status ?? "new",
      assigned_to: body.assigned_to ?? null,
      custom_fields: body.custom_fields ?? {},
    };
    // Re-activate a previously soft-deleted contact with the same phone (unique per org).
    const contact = existing
      // tenant-ok: id from an org-scoped lookup
      ? await prisma.contacts.update({ where: { id: existing.id }, data: { ...data, is_active: true } })
      : await prisma.contacts.create({ data: { ...data, org_id: session.org_id, phone } });

    await incrementUsage(session.org_id, "contacts");
    await audit(session, "contact.create", "contact", contact.id, { after: { phone, full_name: contact.full_name } });
    await sendEvent("contact/created", { org_id: session.org_id, contact_id: contact.id });
    for (const tag of tags) await sendEvent("contact/tag.added", { org_id: session.org_id, contact_id: contact.id, tag });
    return ok(contact, 201);
  },
  { role: "member" }
);
