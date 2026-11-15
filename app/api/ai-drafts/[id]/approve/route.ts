import { z } from "zod";
import { ApiError, ok, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ComplianceError } from "@/lib/compliance";
import { deliverDraft, draftWarnings, type DraftContext } from "@/lib/ai/drafts";

export const runtime = "nodejs";

const Body = z.object({
  body: z.string().trim().min(1).max(4096).optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  /** Required when the final text still has warnings (ungrounded claims / bad placeholders). */
  acknowledge_warnings: z.boolean().default(false),
});

/**
 * POST /api/ai-drafts/:id/approve - a human approves (optionally after editing) and the message is sent.
 * Compliance (consent / opt-out / DNC) is re-checked at send time. The claim is atomic, so double clicks send once.
 */
export const POST = withAuth<{ id: string }>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(404, "Draft not found");
    const input = Body.parse(await req.json().catch(() => ({})));

    const draft = await prisma.ai_drafts.findFirst({ where: { id, org_id: session.org_id } });
    if (!draft) throw new ApiError(404, "Draft not found");
    if (draft.status !== "pending") throw new ApiError(409, `Draft is already ${draft.status}`);

    const finalBody = input.body ?? draft.body;
    const finalSubject = input.subject === undefined ? draft.subject : input.subject;
    const warnings = draftWarnings((draft.context ?? {}) as Partial<DraftContext>, finalBody);
    if (warnings.length && !input.acknowledge_warnings) {
      throw new ApiError(422, `Review warnings first: ${warnings.join("; ")}`, "DRAFT_WARNINGS");
    }

    const claim = await prisma.ai_drafts.updateMany({
      where: { id, org_id: session.org_id, status: "pending" },
      data: { status: "approved", decided_by: session.user.id, decided_at: new Date() },
    });
    if (claim.count === 0) throw new ApiError(409, "Draft was already decided");

    try {
      await deliverDraft(draft, { body: finalBody, subject: finalSubject });
    } catch (e) {
      // release the claim so the draft can be retried / rejected
      await prisma.ai_drafts.updateMany({ where: { id, org_id: session.org_id, status: "approved" }, data: { status: "pending", decided_by: null, decided_at: null } });
      if (e instanceof ComplianceError) throw new ApiError(422, e.message, e.code);
      throw e;
    }

    await prisma.ai_drafts.updateMany({
      where: { id, org_id: session.org_id },
      data: { status: "sent", body: finalBody, subject: finalSubject ?? null },
    });
    await audit(session, "ai_draft.approve", "ai_draft", id, {
      after: { edited: finalBody !== draft.body, acknowledged_warnings: warnings.length > 0, channel: draft.channel },
    });
    return ok({ id, status: "sent" });
  },
  { role: "member" }
);
