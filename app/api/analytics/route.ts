import { withAuth, ok, parseQuery } from "@/lib/api";
import { getAnalytics, resolveRange, RangeQuery } from "@/lib/analytics";

/** GET /api/analytics?range=today|7d|30d|90d|custom&from&to[&insights=1] */
export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, RangeQuery);
  const data = await getAnalytics(session.org_id, resolveRange(q));
  let insights: string | null = null;
  if (q.insights === "1") {
    try {
      const { generateWeeklyInsights } = await import("@/lib/ai");
      insights = await generateWeeklyInsights(data);
    } catch (e) {
      console.error("[analytics] insights failed", e);
      insights = null;
    }
  }
  return ok({ ...data, insights });
});
