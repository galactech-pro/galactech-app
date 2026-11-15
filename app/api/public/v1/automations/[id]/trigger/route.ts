import { z } from "zod";
import { safe, ok, fail, parseBody } from "@/lib/api";
import { publicGuard } from "@/app/api/public/_guard";
import { prisma } from "@/lib/db";
import { sendEvent } from "@/lib/inngest";

const Schema = z
  .object({
    contact_id: z.string().uuid().optional(),
    phone: z.string().max(30).optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .refine((b) => b.contact_id || b.phone, "contact_id or phone is required");

/** L-02: the engine treats payload.test === true as a no-op dry run; never let an API caller set it. */
const omitTest = ({ test: _t, ...rest }: Record<string, unknown>) => rest;

/** POST /api/public/v1/automations/:id/trigger - fires an active automation for one contact. Pro plan. */
export const POST = safe<{ id: string }>(async (req, ctx) => {
  const g = await publicGuard(req);
  if ("response" in g) return g.response;
  const auth = g.auth;
  const { id } = await ctx.params;
  const b = await parseBody(req, Schema);
  const automation = await prisma.automations.findFirst({ where: { id, org_id: auth.org_id } });
  if (!automation) return fail("Automation not found", 404);
  if (!automation.is_active) return fail("Automation is not active", 409);
  if (automation.trigger_type !== "api") return fail("Automation trigger type is not 'api'", 409);

  let contactId = b.contact_id;
  if (!contactId) {
    const { normalizePhone } = await import("@/lib/utils");
    const phone = normalizePhone(b.phone!);
    const c = phone ? await prisma.contacts.findUnique({ where: { org_id_phone: { org_id: auth.org_id, phone } } }) : null;
    contactId = c?.id;
  }
  const contact = contactId ? await prisma.contacts.findFirst({ where: { id: contactId, org_id: auth.org_id, is_active: true } }) : null;
  if (!contact) return fail("Contact not found", 404);

  await sendEvent("automation/trigger", { org_id: auth.org_id, automation_id: id, contact_id: contact.id, payload: b.payload ? omitTest(b.payload) : undefined });
  return ok({ queued: true }, 202);
});
