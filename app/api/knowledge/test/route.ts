import { z } from "zod";
import { withAuth, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { generateMessage } from "@/lib/ai";
import { retrieve } from "@/lib/knowledge";

/** "Ask your AI": shows what it would answer and which pages it used. Sends nothing, creates nothing. */
export const POST = withAuth(
  async (req, session) => {
    const { question } = await parseBody(req, z.object({ question: z.string().trim().min(3).max(500) }));
    const hits = await retrieve(session.org_id, question, 5);
    if (!hits.length) return ok({ answer: null, reason: "Nothing in your knowledge base matches this question.", sources: [] });
    const org = await prisma.organisations.findUnique({ where: { id: session.org_id }, select: { name: true, business_summary: true } });
    const res = await generateMessage({
      goal: "Answer the customer's question using ONLY the approved facts. If the facts do not contain the answer, list what is missing in needs_info and write no message.",
      contact: { name: "there" },
      channel: "whatsapp",
      tone: "friendly",
      orgId: session.org_id,
      orgName: org?.name,
      businessDescription: org?.business_summary ?? undefined,
      approvedOffers: hits.map((h) => h.content.slice(0, 700)),
      conversation: [{ direction: "inbound", text: question }],
      resolveTags: true,
    });
    const sources = [...new Map(hits.map((h) => [h.url ?? h.title, { title: h.title, url: h.url }])).values()];
    if (res.needs_info.length || !res.message) return ok({ answer: null, reason: "The knowledge base does not contain a clear answer.", sources });
    return ok({ answer: res.message, sources });
  },
  { role: "member" }
);
