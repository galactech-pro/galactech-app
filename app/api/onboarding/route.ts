import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { checkLimit, incrementUsage } from "@/lib/limits";
import { normalizePhone } from "@/lib/utils";
import { getTemplate } from "@/lib/templates/automation-templates";
import { audit } from "@/lib/audit";
import { assertPhoneNumberIdAvailable, isUniqueViolation } from "@/lib/tenant";

const profile = z.object({
  step: z.literal(1),
  name: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(1).max(60).default("Asia/Kolkata"),
  language: z.string().trim().min(2).max(10).default("en"),
});
const whatsapp = z.object({
  step: z.literal(2),
  skip: z.boolean().optional(),
  wa_phone_number_id: z.string().trim().min(5).max(40).optional(),
  wa_business_account_id: z.string().trim().min(5).max(40).optional(),
  wa_access_token: z.string().trim().min(20).max(1000).optional(),
});
const contactsStep = z.object({
  step: z.literal(3),
  skip: z.boolean().optional(),
  contacts: z
    .array(z.object({ full_name: z.string().trim().min(1).max(120), phone: z.string().trim().min(5).max(30), email: z.string().trim().email().optional().or(z.literal("")) }))
    .max(500)
    .optional(),
});
const templateStep = z.object({ step: z.literal(4), skip: z.boolean().optional(), template_key: z.string().max(80).optional() });
const done = z.object({ step: z.literal(5) });

const schema = z.discriminatedUnion("step", [profile, whatsapp, contactsStep, templateStep, done]);

export const GET = withAuth(async (_req, session) => {
  const org = await prisma.organisations.findUnique({
    where: { id: session.org_id },
    select: { name: true, timezone: true, language: true, onboarding_step: true, onboarding_done: true, wa_phone_number_id: true, wa_business_account_id: true, wa_access_token: true },
  });
  if (!org) throw new ApiError(404, "Organisation not found");
  const { wa_access_token, ...rest } = org;
  return ok({ ...rest, wa_connected: !!(wa_access_token && org.wa_phone_number_id) });
});

export const PATCH = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    const orgId = session.org_id;
    const extra: Record<string, unknown> = {};

    if (body.step === 1) {
      await prisma.organisations.update({
        where: { id: orgId },
        data: { name: body.name, timezone: body.timezone, language: body.language },
      });
    } else if (body.step === 2 && !body.skip) {
      if (!body.wa_phone_number_id || !body.wa_access_token || !body.wa_business_account_id) {
        throw new ApiError(422, "Phone number ID, WhatsApp Business Account ID and access token are all required.");
      }
      let enc: string;
      try {
        enc = encrypt(body.wa_access_token);
      } catch {
        throw new ApiError(500, "Server encryption is not configured (ENCRYPTION_KEY).");
      }
      await assertPhoneNumberIdAvailable(orgId, body.wa_phone_number_id);
      try {
        await prisma.organisations.update({
          where: { id: orgId },
          data: { wa_phone_number_id: body.wa_phone_number_id, wa_business_account_id: body.wa_business_account_id, wa_access_token: enc },
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new ApiError(409, "This WhatsApp phone number ID cannot be connected. Check the value or contact support.");
        throw e;
      }
      await audit(session, "onboarding.whatsapp_connected", "organisation", orgId);
    } else if (body.step === 3 && !body.skip && body.contacts?.length) {
      const seen = new Set<string>();
      const rows: Prisma.contactsCreateManyInput[] = [];
      let invalid = 0;
      for (const c of body.contacts) {
        const phone = normalizePhone(c.phone);
        if (!phone) { invalid++; continue; }
        if (seen.has(phone)) continue;
        seen.add(phone);
        rows.push({ org_id: orgId, full_name: c.full_name, phone, email: c.email || null, source: "onboarding_import" });
      }
      await checkLimit(orgId, "contacts", rows.length);
      const res = rows.length ? await prisma.contacts.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
      if (res.count) await incrementUsage(orgId, "contacts", res.count);
      extra.imported = res.count;
      extra.invalid = invalid;
    } else if (body.step === 4 && !body.skip && body.template_key) {
      const tpl = getTemplate(body.template_key);
      if (!tpl) throw new ApiError(422, "Unknown template");
      await checkLimit(orgId, "automations");
      const a = await prisma.automations.create({
        data: {
          org_id: orgId,
          name: tpl.name,
          description: tpl.description,
          trigger_type: tpl.trigger_type,
          steps: tpl.graph as unknown as Prisma.InputJsonValue,
          is_active: false,
          created_by: session.user.id,
        },
        select: { id: true },
      });
      extra.automation_id = a.id;
    }

    const finished = body.step === 5;
    const org = await prisma.organisations.update({
      where: { id: orgId },
      data: {
        onboarding_step: finished ? 5 : body.step,
        ...(finished ? { onboarding_done: true } : {}),
      },
      select: { onboarding_step: true, onboarding_done: true },
    });
    return ok({ ...org, ...extra });
  },
  { role: "admin" }
);
