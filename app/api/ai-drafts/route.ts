import { z } from "zod";
import { ok, parseQuery, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { draftWarnings, type DraftContext } from "@/lib/ai/drafts";

export const runtime = "nodejs";

const Query = z.object({ status: z.enum(["pending", "approved", "rejected", "sent", "expired"]).default("pending") });

/** GET /api/ai-drafts?status=pending - AI-written messages waiting for a human decision (newest first). */
export const GET = withAuth(
  async (req, session) => {
    const { status } = parseQuery(req, Query);
    const rows = await prisma.ai_drafts.findMany({
      where: { org_id: session.org_id, status },
      orderBy: { created_at: "desc" },
      take: 100,
      include: { contact: { select: { id: true, full_name: true, company: true, phone: true, email: true } } },
    });
    const pending = status === "pending" ? rows.length : await prisma.ai_drafts.count({ where: { org_id: session.org_id, status: "pending" } });
    return ok({
      pending_count: pending,
      items: rows.map((r) => {
        const ctx = (r.context ?? {}) as Partial<DraftContext>;
        return {
          id: r.id,
          channel: r.channel,
          subject: r.subject,
          body: r.body,
          status: r.status,
          created_at: r.created_at,
          origin: ctx.origin ?? null,
          facts: ctx.facts ?? null,
          warnings: draftWarnings(ctx, r.body),
          contact: r.contact,
        };
      }),
    });
  },
  { role: "member" }
);
