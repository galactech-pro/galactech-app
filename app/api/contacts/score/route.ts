import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { scoreLead } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { sendEvent } from "@/lib/inngest";
import { mapLimit } from "../../_shared/common";

const MAX_PER_REQUEST = 100;
const CONCURRENCY = 5;

const schema = z
  .object({
    contact_id: z.string().uuid().optional(),
    ids: z.array(z.string().uuid()).max(MAX_PER_REQUEST).optional(),
    all_unscored: z.boolean().optional(),
  })
  .refine((b) => b.contact_id || b.ids?.length || b.all_unscored, { message: "Provide contact_id, ids or all_unscored" });

/** Scores up to 100 contacts per call. For all_unscored the response includes `remaining` so the UI can loop. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    const base = { org_id: session.org_id, is_active: true };
    const ids = [...(body.ids ?? []), ...(body.contact_id ? [body.contact_id] : [])];
    const where = ids.length ? { ...base, id: { in: ids } } : { ...base, lead_score: null };

    const contacts = await prisma.contacts.findMany({
      where,
      take: MAX_PER_REQUEST,
      orderBy: { created_at: "asc" },
      include: { messages: { orderBy: { created_at: "desc" }, take: 20 } },
    });
    if (!contacts.length) return body.contact_id ? fail("Contact not found", 404) : ok({ scored: 0, failed: 0, results: [], remaining: 0 });

    const results = await mapLimit(contacts, CONCURRENCY, async (c) => {
      try {
        const r = await scoreLead(c);
        const score = Math.min(10, Math.max(1, Math.round(r.score)));
        await prisma.$transaction([
          // tenant-ok: contact loaded by findMany scoped by org_id
          prisma.contacts.update({ where: { id: c.id }, data: { lead_score: score, score_reason: r.reason } }),
          prisma.score_history.create({ data: { org_id: session.org_id, contact_id: c.id, score, reason: r.reason } }),
        ]);
        if (score !== c.lead_score) {
          await sendEvent("contact/score.changed", { org_id: session.org_id, contact_id: c.id, score, previous: c.lead_score });
        }
        return { id: c.id, ok: true as const, score, reason: r.reason, signals: r.signals };
      } catch (e) {
        return { id: c.id, ok: false as const, error: e instanceof Error ? e.message : "Scoring failed" };
      }
    });

    const scored = results.filter((r) => r.ok).length;
    const remaining = body.all_unscored && !ids.length ? await prisma.contacts.count({ where: { ...base, lead_score: null } }) : 0;
    await audit(session, "contact.score", "contact", body.contact_id ?? null, { after: { scored } });
    return ok({ scored, failed: results.length - scored, results, remaining });
  },
  { role: "member" }
);
