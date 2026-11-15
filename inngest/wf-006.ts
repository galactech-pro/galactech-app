import { inngest, type Events } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { AiError, extractCallOutcome, generateMessage } from "@/lib/ai";
import { routeAiOutbound } from "@/lib/ai/drafts";
import { scoreAndSave } from "@/lib/ai/apply-score";
import { addTag } from "./helpers";

type CallOutcomeName = "interested" | "callback" | "not_interested" | "no_answer" | "voicemail";

const DNC_PHRASES = /\b(do not call|don'?t call|stop calling|never call|remove (?:me|my number)|take me off|not to be called)\b/i;

/** Create a task once per (ai_call, kind). Safe under Inngest step retries (idempotent on the title marker). */
async function ensureTask(orgId: string, aiCallId: string, kind: string, title: string, contactId: string, assignedTo: string | null, dueInHours: number) {
  const marker = `[call:${aiCallId.slice(0, 8)}:${kind}]`;
  const existing = await prisma.tasks.findFirst({ where: { org_id: orgId, contact_id: contactId, title: { contains: marker } } });
  if (existing) return existing.id;
  const t = await prisma.tasks.create({
    data: { org_id: orgId, contact_id: contactId, title: `${title} ${marker}`.slice(0, 250), due_at: new Date(Date.now() + dueInHours * 3600_000), assigned_to: assignedTo },
  });
  return t.id;
}

/**
 * WF-006: call post-processing (H-09).
 *  - NEVER auto-sends anything to the callee. The old "proposal" WhatsApp is gone.
 *  - Outcome comes from extractCallOutcome: transcript wrapped as untrusted data, Zod-validated, "interested" must be
 *    backed by a verbatim quote, and classification failure fails closed into a human review task.
 *  - "interested" => task + deal + a follow-up ai_draft that a human must approve.
 *  - Every step is idempotent for this ai_call id (retries / duplicate call/ended events create nothing twice).
 */
export const wf006CallPostProcessing = inngest.createFunction(
  { id: "wf-006-call-post-processing", retries: 3 },
  { event: "call/ended" },
  async ({ event, step }) => {
    const d = event.data as Events["call/ended"];

    const outcome = await step.run("extract-outcome", async () => {
      const call = await prisma.ai_calls.findFirst({ where: { id: d.ai_call_id, org_id: d.org_id } });
      if (!call) return null;
      let result: { outcome: CallOutcomeName; summary: string } | null;
      if (call.status === "no_answer" || call.status === "failed") {
        result = { outcome: "no_answer", summary: call.summary ?? "The call was not answered." };
      } else if (call.transcript) {
        try {
          const r = await extractCallOutcome(call.transcript, d.org_id);
          result = { outcome: r.outcome, summary: call.summary && !call.summary.includes(r.summary) ? `${call.summary}\n${r.summary}` : r.summary };
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          result = null; // fail closed: no automatic classification
        }
      } else {
        result = { outcome: "no_answer", summary: call.summary ?? "No conversation took place." };
      }
      const dncRequest = Boolean(call.transcript && DNC_PHRASES.test(call.transcript));
      if (result) await prisma.ai_calls.update({ where: { id: call.id, org_id: d.org_id }, data: { outcome: result.outcome, summary: result.summary } });
      return { result, contact_id: call.contact_id, dnc_request: dncRequest };
    });
    if (!outcome) return { skipped: "missing" };

    const c = await step.run("load-contact", async () => {
      const row = await prisma.contacts.findFirst({ where: { id: outcome.contact_id, org_id: d.org_id }, select: { id: true, full_name: true, company: true, status: true, assigned_to: true } });
      return row;
    });
    if (!c) return { skipped: "contact missing" };

    // Deterministic safety net: the callee said "don't call me". Consent fields are changed by a human, not by an LLM.
    if (outcome.dnc_request) {
      await step.run("dnc-review-task", () =>
        ensureTask(d.org_id, d.ai_call_id, "dnc", `Review: ${c.full_name} may have asked not to be called. Check the transcript and mark Do-Not-Contact if so.`, c.id, c.assigned_to, 4)
      );
    }

    if (!outcome.result) {
      await step.run("review-task", () =>
        ensureTask(d.org_id, d.ai_call_id, "review", `Review AI call with ${c.full_name}: automatic classification failed`, c.id, c.assigned_to, 24)
      );
      return { outcome: "unclassified" };
    }
    const { outcome: kind, summary } = outcome.result;

    let drafted: string | null = null;
    if (kind === "interested") {
      await step.run("deal-and-task", async () => {
        const marker = `[ai_call:${d.ai_call_id}]`;
        const existingForCall = await prisma.deals.findFirst({ where: { org_id: d.org_id, contact_id: c.id, notes: { contains: marker } } });
        const openDeal = existingForCall ?? (await prisma.deals.findFirst({ where: { org_id: d.org_id, contact_id: c.id, stage: { notIn: ["won", "lost"] } } }));
        if (!openDeal) {
          await prisma.deals.create({
            data: { org_id: d.org_id, contact_id: c.id, title: `${c.company ?? c.full_name} - AI call opportunity`, stage: "qualified", probability: 30, assigned_to: c.assigned_to, notes: `${summary}\n${marker}`.slice(0, 2000) },
          });
        }
        await ensureTask(d.org_id, d.ai_call_id, "interested", `Follow up with ${c.full_name}: showed interest on AI call (send proposal / book demo yourself)`, c.id, c.assigned_to, 24);
        await prisma.contacts.update({ where: { id: c.id, org_id: d.org_id }, data: { status: c.status === "new" || c.status === "contacted" ? "qualified" : c.status } });
        await addTag(d.org_id, c.id, "call-interested");
      });

      // Follow-up is ALWAYS a draft for a human (forceDraft), never sent automatically, whatever ai_approval_required says.
      drafted = await step.run("followup-draft", async () => {
        try {
          const g = await generateMessage({
            orgId: d.org_id,
            goal: "Thank the person for speaking with us today and offer to share more information or arrange a time to talk with a team member. Do not mention a proposal, prices, offers or specific dates.",
            contact: { name: c.full_name, company: c.company ?? undefined },
            channel: "whatsapp",
            tone: "friendly",
            resolveTags: true,
          });
          if (g.needs_info.length || !g.message) return null;
          const r = await routeAiOutbound({ orgId: d.org_id, contactId: c.id, channel: "whatsapp", body: g.message, origin: "workflow", facts: g.facts, dedupeKey: `wf006:${d.ai_call_id}`, idempotencyKey: `wf006:${d.ai_call_id}`, forceDraft: true });
          return r.draftId ?? null;
        } catch (e) {
          if (e instanceof AiError) return null;
          throw e;
        }
      });
    } else if (kind === "callback") {
      await step.run("callback-task", () => ensureTask(d.org_id, d.ai_call_id, "callback", `Call back ${c.full_name} (requested on AI call)`, c.id, c.assigned_to, 24));
    } else if (kind === "not_interested") {
      await step.run("tag-not-interested", () => addTag(d.org_id, c.id, "call-not-interested"));
    }

    if (kind !== "no_answer") {
      await step.run("rescore", async () => {
        try {
          await scoreAndSave(d.org_id, c.id);
        } catch (e) {
          console.error("[wf-006] rescore failed", e);
        }
      });
    }
    return { outcome: kind, draft: drafted };
  }
);
