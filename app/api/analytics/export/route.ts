import { z } from "zod";
import { NextResponse } from "next/server";
import { withAuth, parseQuery } from "@/lib/api";
import { getAnalytics, resolveRange, RangeQuery, analyticsToCsv, analyticsToPdfLines, simplePdf } from "@/lib/analytics";

const Q = RangeQuery.extend({ format: z.enum(["csv", "pdf"]).default("csv") });

/** GET /api/analytics/export?format=csv|pdf&range=... - streams a file download. */
export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, Q);
  const data = await getAnalytics(session.org_id, resolveRange(q));
  const stamp = new Date().toISOString().slice(0, 10);
  if (q.format === "pdf") {
    const pdf = simplePdf(analyticsToPdfLines(data));
    return new NextResponse(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="analytics-${stamp}.pdf"` },
    });
  }
  return new NextResponse(analyticsToCsv(data), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="analytics-${stamp}.csv"` },
  });
});
