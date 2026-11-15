import { z } from "zod";
import { withAuth, ok, fail, parseQuery } from "@/lib/api";
import { conversationForContact, loadThread } from "@/lib/channels/conversations";
import { uuid } from "../../_shared/common";

type Params = { contactId: string };
const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.coerce.date().optional(),
});

/**
 * Legacy entry point (deep links `?contact=`): returns the thread of the contact's most recent conversation, creating
 * the conversation lazily (and attaching legacy messages) when the contact predates the conversations tables.
 * New code should use /api/inbox/conversations/:id.
 */
export const GET = withAuth<Params>(async (req, session, ctx) => {
  const { contactId } = await ctx.params;
  if (!uuid.safeParse(contactId).success) return fail("Not found", 404);
  const conv = await conversationForContact(session.org_id, contactId);
  return ok(await loadThread(session.org_id, conv.id, parseQuery(req, query)));
});
