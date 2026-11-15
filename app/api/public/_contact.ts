import { z } from "zod";
import { prisma, type Prisma } from "@/lib/db";
import { checkLimit, incrementUsage } from "@/lib/limits";
import { sendEvent } from "@/lib/inngest";
import { normalizePhone } from "@/lib/utils";
import { ApiError } from "@/lib/api";

export const InboundContact = z.object({
  full_name: z.string().min(1).max(200),
  phone: z.string().min(5).max(30),
  email: z.string().email().max(254).optional().nullable(),
  company: z.string().max(200).optional().nullable(),
  job_title: z.string().max(200).optional().nullable(),
  source: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});
export type InboundContact = z.infer<typeof InboundContact>;

/** Create-or-update by (org_id, phone). Emits contact/created only for brand-new contacts. */
export async function upsertInboundContact(orgId: string, c: InboundContact, defaultSource: string) {
  const phone = normalizePhone(c.phone);
  if (!phone) throw new ApiError(422, "Invalid phone number");
  const existing = await prisma.contacts.findUnique({ where: { org_id_phone: { org_id: orgId, phone } } });
  if (existing) {
    const updated = await prisma.contacts.update({
      where: { id: existing.id, org_id: orgId },
      data: {
        full_name: c.full_name,
        email: c.email ?? existing.email,
        company: c.company ?? existing.company,
        job_title: c.job_title ?? existing.job_title,
        is_active: true,
        tags: c.tags ? Array.from(new Set([...existing.tags, ...c.tags])) : undefined,
        custom_fields: c.custom_fields ? ({ ...(existing.custom_fields as object), ...c.custom_fields } as Prisma.InputJsonValue) : undefined,
      },
    });
    return { contact: updated, created: false };
  }
  await checkLimit(orgId, "contacts");
  const contact = await prisma.contacts.create({
    data: {
      org_id: orgId,
      full_name: c.full_name,
      phone,
      email: c.email ?? null,
      company: c.company ?? null,
      job_title: c.job_title ?? null,
      source: c.source ?? defaultSource,
      tags: c.tags ?? [],
      custom_fields: (c.custom_fields ?? {}) as Prisma.InputJsonValue,
    },
  });
  await incrementUsage(orgId, "contacts");
  await sendEvent("contact/created", { org_id: orgId, contact_id: contact.id });
  return { contact, created: true };
}
