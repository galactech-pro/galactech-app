import { z } from "zod";
import { ApiError, ok, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the AI learned from one source. Without ?url it lists pages (title, sections, characters); with ?url it returns that
 * page's extracted text. Private sources never expose their text here (they need the OTP flow).
 */
export const GET = withAuth<{ id: string }>(async (req, session, ctx) => {
  const { id } = await ctx.params;
  const src = await prisma.knowledge_sources.findFirst({ where: { id: z.string().uuid().parse(id), org_id: session.org_id }, select: { id: true, visibility: true, type: true } });
  if (!src) throw new ApiError(404, "Source not found");
  const url = req.nextUrl.searchParams.get("url");
  if (url !== null) {
    if (src.visibility === "private") throw new ApiError(403, "Private knowledge text is hidden");
    const rows = await prisma.knowledge_chunks.findMany({ where: { source_id: src.id, org_id: session.org_id, url }, orderBy: { position: "asc" }, select: { content: true, title: true }, take: 60 });
    return ok({ title: rows[0]?.title ?? url, text: rows.map((r) => r.content).join("\n\n").slice(0, 20000) });
  }
  const rows = await prisma.knowledge_chunks.findMany({ where: { source_id: src.id, org_id: session.org_id }, select: { url: true, title: true, content: true }, take: 3000 });
  const by = new Map<string, { url: string; title: string; sections: number; chars: number }>();
  for (const r of rows) {
    const key = r.url ?? "(note)";
    const e = by.get(key) ?? { url: key, title: r.title, sections: 0, chars: 0 };
    e.sections++;
    e.chars += r.content.length;
    by.set(key, e);
  }
  return ok({ hidden: src.visibility === "private", pages: [...by.values()].sort((a, b) => b.chars - a.chars).slice(0, 300) });
});
