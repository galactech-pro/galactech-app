import { z } from "zod";
import { withAuth, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const schema = z.object({
  business_summary: z.string().trim().max(1500).nullable().optional(),
  auto_reply_mode: z.enum(["off", "draft", "auto"]).optional(),
  handoff_message: z.string().trim().max(300).nullable().optional(),
});

export const PUT = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    await prisma.organisations.update({ where: { id: session.org_id }, data: body });
    await audit(session, "knowledge.settings", "organisation", session.org_id, { after: { auto_reply_mode: body.auto_reply_mode } });
    return ok(body);
  },
  { role: "admin" }
);
