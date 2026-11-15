import { z } from "zod";
import { withAuth, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { syncStaticSource } from "@/lib/knowledge";
import { consumeOtp } from "@/lib/knowledge/otp";

const schema = z.object({ otp_id: z.string().uuid(), code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"), action: z.enum(["add_private", "delete"]) });

/** Step 2: verify the emailed code, then perform the pending action. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    if (body.action === "delete") {
      const p = await consumeOtp<{ source_id: string }>(session.user.id, session.org_id, body.otp_id, body.code, "kb_delete");
      await prisma.knowledge_sources.deleteMany({ where: { id: p.source_id, org_id: session.org_id, visibility: "private" } });
      await audit(session, "knowledge.delete_private", "knowledge_source", p.source_id, {});
      return ok({ deleted: true });
    }
    const p = await consumeOtp<{ title: string; content: string }>(session.user.id, session.org_id, body.otp_id, body.code, "kb_add_private");
    const src = await prisma.knowledge_sources.create({ data: { org_id: session.org_id, type: "text", title: p.title, content: p.content, visibility: "private" } });
    await syncStaticSource(session.org_id, src.id);
    await audit(session, "knowledge.add_private", "knowledge_source", src.id, { after: { title: p.title } });
    return ok({ id: src.id }, 201);
  },
  { role: "admin" }
);
