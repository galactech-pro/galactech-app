import { z } from "zod";
import { ApiError, ok, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** POST /api/ai-drafts/:id/reject - discard a pending draft. Nothing is sent. */
export const POST = withAuth<{ id: string }>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(404, "Draft not found");
    const res = await prisma.ai_drafts.updateMany({
      where: { id, org_id: session.org_id, status: "pending" },
      data: { status: "rejected", decided_by: session.user.id, decided_at: new Date() },
    });
    if (res.count === 0) throw new ApiError(404, "Draft not found or already decided");
    await audit(session, "ai_draft.reject", "ai_draft", id);
    return ok({ id, status: "rejected" });
  },
  { role: "member" }
);
