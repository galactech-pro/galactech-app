import { z } from "zod";
import { prisma } from "@/lib/db";
import { runStructured } from "@/lib/ai";

const schema = z.object({ profile: z.string().default("") });

/**
 * Writes a compact business profile (what they do, offers, prices, audience, location, hours, contact, policies, tone) from the
 * knowledge base, so every AI answer starts from an understanding of the business. Runs after each website sync and on demand.
 * Never overwrites text a person wrote: only when business_summary_auto is true.
 */
export async function refreshBusinessProfile(orgId: string, force = false): Promise<{ updated: boolean; profile?: string }> {
  const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { name: true, business_summary_auto: true } });
  if (!org || (!org.business_summary_auto && !force)) return { updated: false };
  const rows = await prisma.knowledge_chunks.findMany({
    where: { org_id: orgId, visibility: "public" },
    select: { title: true, content: true },
    orderBy: [{ source_id: "asc" }, { url: "asc" }, { position: "asc" }],
    take: 300,
  });
  if (!rows.length) return { updated: false };
  let text = "";
  for (const r of rows) {
    const piece = `## ${r.title}\n${r.content}\n\n`;
    if (text.length + piece.length > 30_000) break;
    text += piece;
  }
  const out = await runStructured({
    kind: "business_profile",
    orgId,
    promptVersion: "profile-v1",
    temperature: 0.2,
    maxTokens: 900,
    schema,
    system:
      "You write internal briefing notes for a customer support assistant. Never use em dashes or en dashes. Plain text, no markdown. Use only facts present in the source text; if something is not stated, leave it out.",
    task:
      `Write a business profile of at most 1400 characters for "${org.name}" covering, in this order and only where known: what the business does and who it serves; main products or services with prices or plans exactly as written; location and service area; opening hours; contact details (phone, email, address, links); ordering, booking, delivery, refund and support policies; the brand's tone of voice. Use short labelled lines such as "Offers: ...". Return JSON: {"profile": string}`,
    trusted: { business_name: org.name },
    untrusted: { website_and_notes: text },
  });
  const profile = out.profile.replace(/[–—]/g, "-").trim().slice(0, 1500);
  if (profile.length < 30) return { updated: false };
  await prisma.organisations.updateMany({ where: { id: orgId }, data: { business_summary: profile, business_summary_auto: true } });
  return { updated: true, profile };
}
