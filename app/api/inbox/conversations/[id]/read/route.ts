import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { uuid } from "../../../../_shared/common";

type Params = { id: string };

/** Mark a conversation read (unread_count = 0). */
export const POST = withAuth<Params>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  const r = await prisma.conversations.updateMany({ where: { id, org_id: session.org_id }, data: { unread_count: 0 } });
  if (r.count === 0) return fail("Conversation not found", 404);
  return ok({ id, unread: 0 });
});
