import { z } from "zod";
import { withAuth, ok, fail, parseBody, ApiError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertPublicUrl } from "@/lib/knowledge/crawl";
import { syncSource } from "@/lib/knowledge";

const MAX_SOURCES = 25;

export const GET = withAuth(async (_req, session) => {
  const [sources, gaps, org] = await Promise.all([
    prisma.knowledge_sources.findMany({
      where: { org_id: session.org_id },
      orderBy: { created_at: "desc" },
      select: { id: true, type: true, title: true, url: true, status: true, error: true, auto_sync: true, sync_every_hours: true, max_pages: true, page_count: true, visibility: true, last_result: true, last_synced_at: true, created_at: true, _count: { select: { chunks: true } } },
    }),
    prisma.knowledge_gaps.count({ where: { org_id: session.org_id, status: "open" } }),
    prisma.organisations.findUnique({ where: { id: session.org_id }, select: { business_summary: true, business_summary_auto: true, auto_reply_mode: true, handoff_message: true } }),
  ]);
  return ok({ sources, open_gaps: gaps, settings: org });
});

const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("website"), url: z.string().trim().min(4).max(300), max_pages: z.number().int().min(1).max(100).default(30) }),
  z.object({ type: z.literal("text"), title: z.string().trim().min(1).max(120), content: z.string().trim().min(20).max(30000) }),
  z.object({ type: z.literal("faq"), title: z.string().trim().min(3).max(300), content: z.string().trim().min(2).max(3000) }),
]);

/** Adds a source and indexes it. Websites are crawled inline (a few seconds to ~30s), so the user sees the result at once. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    if ((await prisma.knowledge_sources.count({ where: { org_id: session.org_id } })) >= MAX_SOURCES) return fail(`You can keep up to ${MAX_SOURCES} sources`, 422);

    let data: { type: string; title: string; url?: string; content?: string; max_pages?: number };
    if (body.type === "website") {
      const url = /^https?:\/\//i.test(body.url) ? body.url : `https://${body.url}`;
      const u = await assertPublicUrl(url).catch((e: Error) => {
        throw new ApiError(422, e.message);
      });
      data = { type: "website", title: u.hostname, url: u.origin, max_pages: body.max_pages };
    } else {
      data = { type: body.type, title: body.title, content: body.content };
    }
    const src = await prisma.knowledge_sources.create({ data: { org_id: session.org_id, ...data } });
    await audit(session, "knowledge.add", "knowledge_source", src.id, { after: { type: src.type, title: src.title } });
    try {
      await syncSource(session.org_id, src.id);
    } catch (e) {
      return ok({ id: src.id, synced: false, error: e instanceof Error ? e.message : "Sync failed" }, 201);
    }
    return ok({ id: src.id, synced: true }, 201);
  },
  { role: "admin" }
);
