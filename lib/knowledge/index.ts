import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { chunkText, contactLinks, discoverPages, fetchText, htmlToText } from "./crawl";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_CHUNKS_PER_ORG = 3000;

// ------------------------------------------------------------------------------------------------ sync

/** Replace all chunks of a text/FAQ source (small, so delete + insert). */
export async function syncStaticSource(orgId: string, sourceId: string): Promise<void> {
  const src = await prisma.knowledge_sources.findFirst({ where: { id: sourceId, org_id: orgId } });
  if (!src) throw new ApiError(404, "Source not found");
  const body = (src.content ?? "").trim();
  const pieces = src.type === "faq" ? [`${src.title}\n${body}`] : chunkText(body);
  await prisma.$transaction([
    prisma.knowledge_chunks.deleteMany({ where: { source_id: src.id, org_id: orgId } }),
    prisma.knowledge_chunks.createMany({
      data: pieces.map((c, i) => ({ org_id: orgId, source_id: src.id, title: src.title, content: c, content_hash: sha(c), position: i, visibility: src.visibility })),
    }),
    prisma.knowledge_sources.updateMany({
      where: { id: src.id, org_id: orgId },
      data: { status: "ready", error: null, page_count: 1, last_synced_at: new Date() },
    }),
  ]);
}

/**
 * Crawl a website and keep the chunk set in step with it: unchanged pages (same hash) are untouched, changed pages are
 * re-chunked, pages that disappeared are deleted. Safe to run repeatedly (cron does, daily).
 */
export async function syncWebsiteSource(orgId: string, sourceId: string): Promise<{ pages: number; changed: number; removed: number; added: string[]; updated: string[]; gone: string[] }> {
  const src = await prisma.knowledge_sources.findFirst({ where: { id: sourceId, org_id: orgId, type: "website" } });
  if (!src || !src.url) throw new ApiError(404, "Source not found");
  await prisma.knowledge_sources.updateMany({ where: { id: src.id, org_id: orgId }, data: { status: "syncing", error: null } });
  try {
    const discovery = await discoverPages(src.url, src.max_pages);
    const urls = discovery.urls;
    if (!urls.length) throw new Error("No pages found. Check the address and that the site is public.");

    const existing = await prisma.knowledge_chunks.findMany({ where: { source_id: src.id, org_id: orgId }, select: { url: true, content_hash: true } });
    const oldByUrl = new Map<string, Set<string>>();
    for (const e of existing) {
      if (!e.url) continue;
      (oldByUrl.get(e.url) ?? oldByUrl.set(e.url, new Set()).get(e.url)!).add(e.content_hash);
    }

    let changed = 0;
    let pages = 0;
    const added: string[] = [];
    const updated: string[] = [];
    const seen = new Set<string>();
    const failed: string[] = [];
    const thin: string[] = [];
    const contacts = new Set<string>();
    let homeFooter = "";
    const origin = new URL(src.url).origin;
    const queue = [...urls];
    const worker = async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        const page = await fetchText(u).catch(() => null);
        if (!page) {
          failed.push(u);
          continue;
        }
        const { title, text, footer } = htmlToText(page.body);
        for (const c of contactLinks(page.body)) contacts.add(c);
        if (!homeFooter && footer) homeFooter = footer; // the first page read is the home page
        const chunks = chunkText(text);
        if (text.length < 200) thin.push(u);
        if (!chunks.length) continue;
        pages++;
        seen.add(u);
        const hashes = new Set(chunks.map(sha));
        const old = oldByUrl.get(u);
        if (old && old.size === hashes.size && [...hashes].every((h) => old.has(h))) continue; // unchanged
        changed++;
        (old ? updated : added).push(u);
        await prisma.$transaction([
          prisma.knowledge_chunks.deleteMany({ where: { source_id: src.id, org_id: orgId, url: u } }),
          prisma.knowledge_chunks.createMany({
            data: chunks.map((c, i) => ({ org_id: orgId, source_id: src.id, url: u, title: title || u, content: c, content_hash: sha(c), position: i })),
          }),
        ]);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    // Phone numbers, emails, WhatsApp and social links usually live in headers and footers: keep them as one "contact" page
    const contactUrl = `${origin}#contact`;
    const contactText = [...contacts, homeFooter].filter(Boolean).join("\n");
    if (contactText.length >= 20) {
      const cchunks = chunkText(contactText, 900);
      const chashes = cchunks.map(sha);
      const cold = oldByUrl.get(contactUrl);
      seen.add(contactUrl);
      if (!(cold && cold.size === new Set(chashes).size && chashes.every((h) => cold.has(h)))) {
        await prisma.$transaction([
          prisma.knowledge_chunks.deleteMany({ where: { source_id: src.id, org_id: orgId, url: contactUrl } }),
          prisma.knowledge_chunks.createMany({ data: cchunks.map((c, i) => ({ org_id: orgId, source_id: src.id, url: contactUrl, title: "Contact details and links", content: c, content_hash: sha(c), position: i })) }),
        ]);
      }
    }

    // Pages that vanished from the site stop being quoted. Only prune after a healthy crawl so one outage can't wipe the KB.
    let removed = 0;
    let gone: string[] = [];
    if (pages > 0 && pages >= Math.floor(oldByUrl.size / 2)) {
      gone = [...oldByUrl.keys()].filter((u) => !seen.has(u));
      if (gone.length) removed = (await prisma.knowledge_chunks.deleteMany({ where: { source_id: src.id, org_id: orgId, url: { in: gone } } })).count;
    }
    if (pages === 0) throw new Error("Pages were found but none had readable text (the site may need JavaScript to render).");
    const total = await prisma.knowledge_chunks.count({ where: { org_id: orgId } });
    if (total > MAX_CHUNKS_PER_ORG) throw new Error(`Knowledge base is too large (${total} sections). Remove a source or lower the page limit.`);

    await prisma.knowledge_sources.updateMany({
      where: { id: src.id, org_id: orgId },
      data: { status: "ready", error: null, page_count: pages, last_synced_at: new Date(), last_result: {
          added: added.slice(0, 50), updated: updated.slice(0, 50), removed: gone.slice(0, 50),
          report: { sitemap: discovery.sitemap, sitemap_urls: discovery.sitemapUrls, via_links: discovery.viaLinks, discovered: urls.length, read: pages, failed: failed.slice(0, 20), thin: thin.slice(0, 20), contact_found: contactText.length >= 20 },
        } },
    });
    return { pages, changed, removed, added, updated, gone };
  } catch (e) {
    await prisma.knowledge_sources.updateMany({
      where: { id: src.id, org_id: orgId },
      data: { status: "error", error: (e instanceof Error ? e.message : "Sync failed").slice(0, 300) },
    });
    throw e;
  }
}

export async function syncSource(orgId: string, sourceId: string) {
  const src = await prisma.knowledge_sources.findFirst({ where: { id: sourceId, org_id: orgId }, select: { type: true } });
  if (!src) throw new ApiError(404, "Source not found");
  const result = src.type === "website" ? await syncWebsiteSource(orgId, sourceId) : await syncStaticSource(orgId, sourceId);
  // Keep the AI's understanding of the business current: rewrite the profile whenever the knowledge changed
  try {
    const { refreshBusinessProfile } = await import("./profile");
    await refreshBusinessProfile(orgId);
  } catch (e) {
    console.error("[knowledge] profile refresh failed", e);
  }
  return result;
}

// ------------------------------------------------------------------------------------------------ retrieval

const STOP = new Set("the a an and or of to in on for is are was were be it this that with at by from as do does did can could i you we our your my me what how when where which who why please hi hello hey thanks thank have has any there their about".split(" "));

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOP.has(t));
}

export interface KnowledgeHit {
  id: string;
  title: string;
  url: string | null;
  content: string;
  visibility: string;
  score: number;
}

/**
 * Keyword retrieval (no embeddings: free, fast, multilingual-safe). Narrows in SQL on the question's rarest words, then
 * ranks by weighted overlap with a title boost. Good enough for FAQ-style questions; swap for pgvector later if needed.
 */
export async function retrieve(orgId: string, question: string, k = 5): Promise<KnowledgeHit[]> {
  const qs = [...new Set(tokens(question))].slice(0, 12);
  if (!qs.length) return [];
  const rows = await prisma.knowledge_chunks.findMany({
    where: { org_id: orgId, OR: qs.map((t) => ({ content: { contains: t, mode: "insensitive" as const } })) },
    select: { id: true, title: true, url: true, content: true, visibility: true },
    take: 400,
  });
  const df = new Map<string, number>();
  const lowered = rows.map((r) => ({ r, c: r.content.toLowerCase(), t: r.title.toLowerCase() }));
  for (const q of qs) df.set(q, lowered.filter((x) => x.c.includes(q)).length || 1);
  const n = Math.max(rows.length, 1);
  return lowered
    .map(({ r, c, t }) => {
      let score = 0;
      for (const q of qs) {
        if (c.includes(q)) score += 1 + Math.log(1 + n / df.get(q)!);
        if (t.includes(q)) score += 1.5;
      }
      return { ...r, score };
    })
    .filter((h) => h.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ------------------------------------------------------------------------------------------------ gaps (self-improving loop)

/** Record a question the knowledge base could not answer. Repeats increment a counter instead of spamming rows. */
export async function recordGap(orgId: string, question: string, conversationId?: string | null): Promise<void> {
  const q = question.replace(/\s+/g, " ").trim().slice(0, 300);
  if (q.length < 5) return;
  const key = tokens(q).sort().join(" ");
  const open = await prisma.knowledge_gaps.findMany({ where: { org_id: orgId, status: "open" }, select: { id: true, question: true }, take: 200 });
  const dup = open.find((g) => tokens(g.question).sort().join(" ") === key);
  if (dup) {
    await prisma.knowledge_gaps.updateMany({ where: { id: dup.id, org_id: orgId }, data: { count: { increment: 1 }, last_seen_at: new Date() } });
    return;
  }
  await prisma.knowledge_gaps.create({ data: { org_id: orgId, question: q, conversation_id: conversationId ?? null } });
}
