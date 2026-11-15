import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { syncSource } from "@/lib/knowledge";

const schema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().trim().min(2).max(30000).optional(),
  auto_sync: z.boolean().optional(),
  sync_every_hours: z.number().int().min(1).max(720).optional(),
  max_pages: z.number().int().min(1).max(100).optional(),
});

export const PATCH = withAuth<{ id: string }>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, schema);
    const src = await prisma.knowledge_sources.findFirst({ where: { id, org_id: session.org_id } });
    if (!src) return fail("Source not found", 404);
    await prisma.knowledge_sources.updateMany({ where: { id, org_id: session.org_id }, data: body });
    if (src.type !== "website" && (body.content !== undefined || body.title !== undefined)) await syncSource(session.org_id, id);
    return ok({ id });
  },
  { role: "admin" }
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    const src = await prisma.knowledge_sources.findFirst({ where: { id, org_id: session.org_id }, select: { visibility: true } });
    if (src?.visibility === "private") return fail("Private sources are removed with an emailed confirmation code", 422, "OTP_REQUIRED");
    const r = await prisma.knowledge_sources.deleteMany({ where: { id, org_id: session.org_id } });
    if (!r.count) return fail("Source not found", 404);
    await audit(session, "knowledge.delete", "knowledge_source", id, {});
    return ok({ id });
  },
  { role: "admin" }
);
