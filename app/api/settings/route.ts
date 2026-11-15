import { z } from "zod";
import { withAuth, ok, fail, parseBody, ApiError } from "@/lib/api";
import { assertPhoneNumberIdAvailable, isUniqueViolation } from "@/lib/tenant";
import { prisma, type Prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";

const orgSelect = {
  id: true, name: true, slug: true, logo_url: true, plan: true, trial_ends_at: true,
  wa_phone_number_id: true, wa_access_token: true, wa_business_account_id: true,
  resend_api_key: true, elevenlabs_voice_id: true, timezone: true, language: true,
  white_label: true, custom_domain: true, onboarding_done: true, created_at: true,
  call_window_start: true, call_window_end: true, auto_outreach_enabled: true, ai_approval_required: true,
} satisfies Prisma.organisationsSelect;

type OrgRow = Prisma.organisationsGetPayload<{ select: typeof orgSelect }>;

/** Never returns secrets: tokens become booleans. */
function sanitize(o: OrgRow) {
  const { wa_access_token, resend_api_key, ...rest } = o;
  return {
    ...rest,
    whatsapp: {
      connected: !!(o.wa_phone_number_id && wa_access_token && o.wa_business_account_id),
      phone_number_id: o.wa_phone_number_id,
      business_account_id: o.wa_business_account_id,
      access_token: wa_access_token ? "••••••••" : null,
    },
    email: { connected: !!resend_api_key, resend_api_key: resend_api_key ? "••••••••" : null },
    voice: { elevenlabs_voice_id: o.elevenlabs_voice_id },
  };
}

export const GET = withAuth(async (_req, session) => {
  const org = await prisma.organisations.findUnique({ where: { id: session.org_id }, select: orgSelect });
  if (!org) return fail("Organisation not found", 404);
  return ok(sanitize(org));
});

const Schema = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(60).optional(),
  language: z.string().min(2).max(10).optional(),
  wa_phone_number_id: z.string().max(60).nullable().optional(),
  wa_business_account_id: z.string().max(60).nullable().optional(),
  /** Send a new value to replace; null disconnects; omit/empty keeps the stored token. */
  wa_access_token: z.string().max(1000).nullable().optional(),
  resend_api_key: z.string().max(500).nullable().optional(),
  elevenlabs_voice_id: z.string().max(100).nullable().optional(),
  white_label: z.boolean().optional(),
  custom_domain: z.string().max(253).regex(/^[a-z0-9.-]+$/i, "Invalid domain").nullable().optional(),
  /** Local hour [0-23] in the org timezone; AI calls only inside [start, end). Whether/what hours are legally required is UNVERIFIED (docs/OPEN_QUESTIONS.md). */
  call_window_start: z.number().int().min(0).max(23).optional(),
  call_window_end: z.number().int().min(0).max(23).optional(),
  auto_outreach_enabled: z.boolean().optional(),
  ai_approval_required: z.boolean().optional(),
});

export const PATCH = withAuth(
  async (req, session) => {
    const b = await parseBody(req, Schema);
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: b.timezone });
      } catch {
        return fail("Invalid timezone", 422);
      }
    }
    if ((b.white_label !== undefined || b.custom_domain !== undefined) && session.plan !== "pro" && (b.white_label === true || b.custom_domain)) {
      return fail("White-label and custom domain require the Pro plan", 402, "PLAN_LIMIT");
    }
    const cur = await prisma.organisations.findUnique({
      where: { id: session.org_id },
      select: { call_window_start: true, call_window_end: true, auto_outreach_enabled: true, ai_approval_required: true },
    });
    if (!cur) return fail("Organisation not found", 404);
    const winStart = b.call_window_start ?? cur.call_window_start;
    const winEnd = b.call_window_end ?? cur.call_window_end;
    if ((b.call_window_start !== undefined || b.call_window_end !== undefined) && winStart >= winEnd) {
      return fail("call_window_start must be earlier than call_window_end (hours 0-23)", 422);
    }
    if (b.wa_phone_number_id) await assertPhoneNumberIdAvailable(session.org_id, b.wa_phone_number_id);
    const data: Prisma.organisationsUpdateInput = {};
    for (const k of ["call_window_start", "call_window_end", "auto_outreach_enabled", "ai_approval_required"] as const) {
      if (b[k] !== undefined) (data as Record<string, unknown>)[k] = b[k];
    }
    for (const k of ["name", "timezone", "language", "wa_phone_number_id", "wa_business_account_id", "elevenlabs_voice_id", "white_label", "custom_domain"] as const) {
      if (b[k] !== undefined) (data as Record<string, unknown>)[k] = b[k];
    }
    if (b.wa_access_token === null) data.wa_access_token = null;
    else if (b.wa_access_token) data.wa_access_token = encrypt(b.wa_access_token);
    if (b.resend_api_key === null) data.resend_api_key = null;
    else if (b.resend_api_key) data.resend_api_key = encrypt(b.resend_api_key);

    let org: OrgRow;
    try {
      org = await prisma.organisations.update({ where: { id: session.org_id }, data, select: orgSelect });
    } catch (e) {
      // lost a race for the same phone_number_id: same generic answer
      if (isUniqueViolation(e)) throw new ApiError(409, "This WhatsApp phone number ID cannot be connected. Check the value or contact support.");
      throw e;
    }
    // never log secret values; compliance toggles are non-secret so before/after are recorded
    const compliance = ["call_window_start", "call_window_end", "auto_outreach_enabled", "ai_approval_required"] as const;
    const changed = compliance.filter((k) => b[k] !== undefined && b[k] !== cur[k]);
    await audit(session, "settings.update", "organisation", session.org_id, {
      after: { fields: Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined) },
    });
    if (changed.length) {
      await audit(session, "settings.compliance_update", "organisation", session.org_id, {
        before: Object.fromEntries(changed.map((k) => [k, cur[k]])),
        after: Object.fromEntries(changed.map((k) => [k, b[k] as number | boolean])),
      });
    }
    return ok(sanitize(org));
  },
  { role: "admin" }
);
