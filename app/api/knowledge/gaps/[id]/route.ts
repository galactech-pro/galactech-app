import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { syncStaticSource } from "@/lib/knowledge";

/** A person answers an unanswered question once; it becomes an FAQ source the AI uses from then on. */
export const POST = withAuth<{ id: string }>(
  async (req, session, ctx) => {
    const { id } = await ctx.params;
    const { answer } = await parseBody(req, z.object({ answer: z.string().trim().min(2).max(3000) }));
    const gap = await prisma.knowledge_gaps.findFirst({ where: { id, org_id: session.org_id, status: "open" } });
    if (!gap) return fail("Question not found", 404);
    const src = await prisma.knowledge_sources.create({ data: { org_id: session.org_id, type: "faq", title: gap.question, content: answer } });
    await syncStaticSource(session.org_id, src.id);
    await prisma.knowledge_gaps.updateMany({ where: { id, org_id: session.org_id }, data: { status: "answered" } });
    return ok({ source_id: src.id }, 201);
  },
  { role: "member" }
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, session, ctx) => {
    const { id } = await ctx.params;
    await prisma.knowledge_gaps.updateMany({ where: { id, org_id: session.org_id }, data: { status: "dismissed" } });
    return ok({ id });
  },
  { role: "member" }
);
