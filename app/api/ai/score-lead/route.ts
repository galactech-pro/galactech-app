import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { scoreAndSave } from "@/lib/ai/apply-score";

export const runtime = "nodejs";

const Body = z.object({ contact_id: z.string().uuid() });

/** Hybrid score: deterministic features (always) + bounded (+/-2) AI adjustment. `reason` lists the computed features. */
export const POST = withAuth(
  async (req, session) => {
    const { contact_id } = await parseBody(req, Body);
    const r = await scoreAndSave(session.org_id, contact_id);
    if (!r) throw new ApiError(404, "Contact not found");
    return ok({ score: r.score, reason: r.reason, signals: r.signals });
  },
  { role: "member" }
);
