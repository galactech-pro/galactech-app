import { z } from "zod";
import { withAuth, ok, fail, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { loadThread } from "@/lib/channels/conversations";
import { uuid } from "../../../_shared/common";

type Params = { id: string };
const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.coerce.date().optional(),
});

/** Thread of one conversation, oldest -> newest, plus the channel's session-window state (from conversations.last_inbound_at). */
export const GET = withAuth<Params>(async (req, session, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail("Not found", 404);
  return ok(await loadThread(session.org_id, id, parseQuery(req, query)));
});

const patch = z
  .object({
    status: z.enum(["open", "pending", "resolved", "snoozed"]).optional(),
    assignee_id: z.union([z.string().uuid(), z.literal("me")]).nullable().optional(), // "me" = the caller
  })
  .refine((b) => b.status !== undefined || b.assignee_id !== undefined, { message: "Nothing to update" });

/** Resolve / reopen / assign. */
export const PATCH = withAuth<Params>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    if (!uuid.safeParse(id).success) return fail("Not found", 404);
    const body = await parseBody(req, patch);
    if (body.assignee_id === "me") body.assignee_id = session.user.id;
    const conv = await prisma.conversations.findFirst({ where: { id, org_id: session.org_id }, select: { id: true, status: true, assignee_id: true } });
    if (!conv) return fail("Conversation not found", 404);
    if (body.assignee_id) {
      const u = await prisma.users.findFirst({ where: { id: body.assignee_id, org_id: session.org_id, is_active: true }, select: { id: true } });
      if (!u) return fail("User not found", 422);
    }
    // tenant-ok: conversation verified org-scoped by findFirst above
    const updated = await prisma.conversations.update({
      where: { id },
      data: { ...(body.status !== undefined ? { status: body.status } : {}), ...(body.assignee_id !== undefined ? { assignee_id: body.assignee_id } : {}) },
    });
    await audit(session, "inbox.conversation_update", "conversation", id, {
      before: { status: conv.status, assignee_id: conv.assignee_id },
      after: { status: updated.status, assignee_id: updated.assignee_id },
    });
    return ok(updated);
  },
  { role: "member" }
);
