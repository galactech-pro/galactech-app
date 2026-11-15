import { withAuth, ok } from "@/lib/api";
import { syncSource } from "@/lib/knowledge";

export const POST = withAuth<{ id: string }>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    return ok(await syncSource(session.org_id, id));
  },
  { role: "admin" }
);
