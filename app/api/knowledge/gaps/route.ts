import { withAuth, ok } from "@/lib/api";
import { prisma } from "@/lib/db";

/** Questions customers asked that the knowledge base could not answer, most-asked first. */
export const GET = withAuth(async (_req, session) => {
  const gaps = await prisma.knowledge_gaps.findMany({
    where: { org_id: session.org_id, status: "open" },
    orderBy: [{ count: "desc" }, { last_seen_at: "desc" }],
    take: 50,
    select: { id: true, question: true, count: true, last_seen_at: true },
  });
  return ok(gaps);
});
