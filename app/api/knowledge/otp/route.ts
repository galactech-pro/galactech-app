import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { issueOtp } from "@/lib/knowledge/otp";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_private"), title: z.string().trim().min(1).max(120), content: z.string().trim().min(10).max(60000) }),
  z.object({ action: z.literal("delete"), source_id: z.string().uuid() }),
]);

/** Step 1: validate the request and email a 6-digit code. Nothing changes until /otp/confirm succeeds. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    if (body.action === "delete") {
      const src = await prisma.knowledge_sources.findFirst({ where: { id: body.source_id, org_id: session.org_id, visibility: "private" }, select: { id: true } });
      if (!src) return fail("Private source not found", 404);
      return ok(await issueOtp(session.user, session.org_id, "kb_delete", { source_id: src.id }));
    }
    return ok(await issueOtp(session.user, session.org_id, "kb_add_private", { title: body.title, content: body.content }));
  },
  { role: "admin" }
);
