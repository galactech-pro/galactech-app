import { z } from "zod";
import { withAuth, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { answerCustomer } from "@/lib/knowledge/answer";

/** "Ask your AI": shows what it would answer to a customer, using the same engine as real replies. Sends nothing, creates nothing. */
export const POST = withAuth(
  async (req, session) => {
    const { question } = await parseBody(req, z.object({ question: z.string().trim().min(3).max(500) }));
    const org = await prisma.organisations.findUnique({ where: { id: session.org_id }, select: { name: true } });
    const ans = await answerCustomer({ orgId: session.org_id, contact: { name: "there" }, channel: "chat", conversation: [{ direction: "inbound", text: question }] });
    const sources = ans.sources.map((u) => ({ title: u.includes("#contact") ? "Contact details" : u, url: u.includes("#contact") ? null : u }));
    if (!ans.reply) return ok({ answer: null, reason: `${org?.name ?? "Your AI"} cannot answer this from the knowledge base yet.${ans.missing.length ? ` Missing: ${ans.missing.join(", ")}.` : ""}`, sources, status: ans.status });
    return ok({ answer: ans.reply, sources, status: ans.status, missing: ans.missing, confirmed: ans.confirmed });
  },
  { role: "member" }
);
