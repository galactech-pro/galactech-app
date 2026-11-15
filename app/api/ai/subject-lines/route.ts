import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { AiError, AiLimitError, generateSubjectLines } from "@/lib/ai";

export const runtime = "nodejs";

const Body = z.object({
  goal: z.string().min(3).max(500),
  body: z.string().max(5000).optional(),
  approved_offers: z.array(z.string().max(300)).max(10).optional(),
});

export const POST = withAuth(
  async (req, session) => {
    const { approved_offers, ...body } = await parseBody(req, Body);
    try {
      return ok(await generateSubjectLines({ ...body, orgId: session.org_id, approvedOffers: approved_offers }));
    } catch (e) {
      if (e instanceof AiLimitError) throw new ApiError(429, e.message);
      if (e instanceof AiError) throw new ApiError(503, e.message);
      throw e;
    }
  },
  { role: "member" }
);
