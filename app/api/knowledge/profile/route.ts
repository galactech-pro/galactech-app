import { ApiError, ok, withAuth } from "@/lib/api";
import { refreshBusinessProfile } from "@/lib/knowledge/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rewrite the business profile from the current knowledge (and switch it back to auto-updating). */
export const POST = withAuth(
  async (_req, session) => {
    const r = await refreshBusinessProfile(session.org_id, true);
    if (!r.updated) throw new ApiError(422, "Add your website or a note first, so there is something to write the profile from.");
    return ok({ profile: r.profile });
  },
  { role: "admin", rateLimit: { limit: 6, windowSec: 60 } }
);
