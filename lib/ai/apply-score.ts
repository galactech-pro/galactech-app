import { prisma } from "@/lib/db";
import { sendEvent } from "@/lib/inngest";
import { scoreLead } from "./index";

/**
 * Score a contact (hybrid: deterministic features + optional bounded LLM adjustment), persist score + history,
 * emit contact/score.changed. Returns null if contact missing.
 * `useLlm:false` = features only (no LLM call, no injection surface) - used by reply handlers.
 */
export async function scoreAndSave(orgId: string, contactId: string, opts: { useLlm?: boolean } = {}) {
  const contact = await prisma.contacts.findFirst({
    where: { id: contactId, org_id: orgId },
    include: { messages: { orderBy: { created_at: "desc" }, take: 20 } },
  });
  if (!contact) return null;
  const [calls, deals] = await Promise.all([
    prisma.ai_calls.findMany({ where: { org_id: orgId, contact_id: contactId, outcome: { not: null } }, select: { outcome: true }, take: 20 }),
    prisma.deals.findMany({ where: { org_id: orgId, contact_id: contactId }, select: { stage: true }, take: 20 }),
  ]);
  const result = await scoreLead(
    { ...contact, messages: [...contact.messages].reverse() },
    {
      callOutcomes: calls.map((c) => c.outcome as string),
      dealStages: deals.map((d) => d.stage as string),
      useLlm: opts.useLlm,
    }
  );
  await setScore(orgId, contactId, result.score, result.reason, contact.lead_score);
  return { score: result.score, reason: result.reason, signals: result.signals, previous: contact.lead_score };
}

/** Persist a score (no AI). */
export async function setScore(orgId: string, contactId: string, score: number, reason: string, previous: number | null) {
  const clamped = Math.max(1, Math.min(10, Math.round(score)));
  await prisma.contacts.updateMany({ where: { id: contactId, org_id: orgId }, data: { lead_score: clamped, score_reason: reason } });
  await prisma.score_history.create({ data: { org_id: orgId, contact_id: contactId, score: clamped, reason } });
  await sendEvent("contact/score.changed", { org_id: orgId, contact_id: contactId, score: clamped, previous });
  return clamped;
}
