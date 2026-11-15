import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { AiError, AiLimitError, generateMessage } from "@/lib/ai";

export const runtime = "nodejs";

const Body = z.object({
  goal: z.string().min(3).max(500),
  contact: z.object({
    name: z.string().min(1).max(120),
    company: z.string().max(120).optional(),
    industry: z.string().max(120).optional(),
  }),
  channel: z.enum(["whatsapp", "email"]).default("whatsapp"),
  tone: z.enum(["professional", "friendly", "urgent"]).default("friendly"),
  /** Optional grounding: the ONLY offers/prices the AI may mention, and a short business description. */
  approved_offers: z.array(z.string().max(300)).max(10).optional(),
  business_description: z.string().max(600).optional(),
});

/** Returns text for a human to review/edit. Never sends. Merge tags ({name},{company},{email},{phone}) stay unresolved. */
export const POST = withAuth(
  async (req, session) => {
    const { approved_offers, business_description, ...body } = await parseBody(req, Body);
    try {
      return ok(
        await generateMessage({ ...body, orgId: session.org_id, approvedOffers: approved_offers, businessDescription: business_description })
      );
    } catch (e) {
      if (e instanceof AiLimitError) throw new ApiError(429, e.message);
      if (e instanceof AiError) throw new ApiError(503, e.message);
      throw e;
    }
  },
  { role: "member" }
);
