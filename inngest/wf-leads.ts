import { inngest, sendEvent, type Events } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { AiError, generateMessage } from "@/lib/ai";
import { routeAiOutbound } from "@/lib/ai/drafts";
import { scoreAndSave } from "@/lib/ai/apply-score";
import { applyStopKeyword, autoOutreachAllowed, canDialNow, safeContact } from "@/lib/compliance";
import { initiateCall } from "@/lib/voice";
import { ApiError } from "@/lib/api";
import { PlanLimitError } from "@/lib/limits";
import { addTag, appUrl, emailToContact, hasInboundSince, slackAlert, waToContact, type Outcome } from "./helpers";
import { sendSystemEmail, renderSimple } from "@/lib/email";

type OutreachOutcome = Outcome & { drafted?: boolean };

/**
 * AI-written outreach for workflows (H-06, M-12, M-13):
 *  1. compliance gate first (consent + org.auto_outreach_enabled + opt-outs) - skip, never fail
 *  2. grounded generation (fail-closed validation); on any AI failure fall back to the STATIC template
 *     (static templates are not AI output, so they are not approval-gated)
 *  3. AI text goes through routeAiOutbound: pending ai_drafts row when org.ai_approval_required (default), else sent.
 */
async function aiOutreach(
  orgId: string,
  contactId: string,
  goal: string,
  channel: "whatsapp" | "email",
  fallback: string,
  dedupeKey: string,
  fallbackSubject = "Following up"
): Promise<OutreachOutcome> {
  const gate = await safeContact(orgId, contactId, channel, { purpose: "marketing", automated: true });
  if (!gate.allowed) return { ok: false, reason: gate.message, code: gate.code };
  const sendStatic = () =>
    channel === "whatsapp" ? waToContact(orgId, contactId, fallback, `wf:${dedupeKey}`) : emailToContact(orgId, contactId, fallbackSubject, fallback, `wf:${dedupeKey}`);

  const c = await prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId, is_active: true } });
  if (!c) return { ok: false, reason: "contact not found" };
  try {
    const g = await generateMessage({
      orgId,
      goal,
      contact: { name: c.full_name, company: c.company ?? undefined, email: c.email ?? undefined, phone: c.phone },
      channel,
      tone: "friendly",
      resolveTags: true,
    });
    if (g.needs_info.length || !g.message) return sendStatic();
    const r = await routeAiOutbound({
      orgId,
      contactId,
      channel,
      subject: channel === "email" ? g.subject ?? fallbackSubject : null,
      body: g.message,
      origin: "workflow",
      facts: g.facts,
      dedupeKey,
      idempotencyKey: `wf:${dedupeKey}`,
    });
    return { ok: r.ok, reason: r.reason, code: r.code, drafted: r.drafted };
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    return sendStatic(); // AI unavailable / failed validation (fail closed) -> static, non-AI template
  }
}

/** WF-001: new lead welcome. Does nothing unless org.auto_outreach_enabled AND the contact has consent (H-06). */
export const wf001NewLeadWelcome = inngest.createFunction(
  { id: "wf-001-new-lead-welcome", retries: 3 },
  { event: "contact/created" },
  async ({ event, step }) => {
    const d = event.data as Events["contact/created"];
    // wait so that consent capture (import attestation, form receiver) can land after the contact row
    await step.sleep("wait-2m", "2m");

    const welcome = await step.run("send-welcome", async (): Promise<OutreachOutcome> => {
      if (!(await autoOutreachAllowed(d.org_id, d.contact_id))) return { ok: false, reason: "auto outreach disabled or no consent" };
      const org = await prisma.organisations.findUnique({ where: { id: d.org_id }, select: { name: true } });
      return aiOutreach(
        d.org_id,
        d.contact_id,
        `Warmly welcome a new lead on behalf of ${org?.name ?? "our team"} and ask how we can help. Do not mention any offers.`,
        "whatsapp",
        `Hi {name}, thanks for your interest in ${org?.name ?? "us"}! How can we help you today?`,
        `wf001:${d.contact_id}`
      );
    });

    if (welcome.ok && !welcome.drafted) {
      await step.run("tag-welcomed", async () => {
        if (await addTag(d.org_id, d.contact_id, "welcomed")) {
          await sendEvent("contact/tag.added", { org_id: d.org_id, contact_id: d.contact_id, tag: "welcomed" });
        }
      });
    }

    await step.run("score-lead", async () => {
      try {
        await scoreAndSave(d.org_id, d.contact_id);
      } catch (e) {
        console.error("[wf-001] scoring failed", e);
      }
    });
    return { welcomed: welcome.ok, drafted: Boolean(welcome.drafted), reason: welcome.reason, code: welcome.code };
  }
);

/**
 * WF-002: follow-up sequence (Day1 WA, Day3 email, Day5 WA if no reply, Day7 AI call if score > 6). Aborts on reply.
 * The whole sequence is skipped unless org.auto_outreach_enabled; every send re-checks consent/opt-out/window (H-05/H-06).
 */
export const wf002FollowUp = inngest.createFunction(
  {
    id: "wf-002-follow-up-sequence",
    retries: 2,
    cancelOn: [{ event: "message/inbound", match: "data.contact_id" }],
  },
  { event: "contact/created" },
  async ({ event, step }) => {
    const d = event.data as Events["contact/created"];
    const startedAt = new Date(event.ts ?? Date.now());

    const eligible = await step.run("eligible", async () => {
      const org = await prisma.organisations.findUnique({ where: { id: d.org_id }, select: { auto_outreach_enabled: true } });
      if (!org?.auto_outreach_enabled) return "auto_outreach_disabled";
      const c = await prisma.contacts.findFirst({ where: { id: d.contact_id, org_id: d.org_id, is_active: true } });
      if (!c || c.source === "whatsapp_inbound") return "ineligible";
      return "ok";
    });
    if (eligible !== "ok") return { skipped: eligible };

    const replied = () => hasInboundSince(d.org_id, d.contact_id, startedAt);

    await step.sleep("day-1", "1d");
    if (await step.run("check-1", replied)) return { stopped: "replied", at: 1 };
    await step.run("day1-whatsapp", () =>
      aiOutreach(d.org_id, d.contact_id, "Friendly follow-up one day after first contact; offer help and ask about their needs. Do not mention any offers.", "whatsapp", "Hi {name}, just following up. Do you have any questions I can help with?", `wf002-d1:${d.contact_id}`)
    );

    await step.sleep("day-3", "2d");
    if (await step.run("check-3", replied)) return { stopped: "replied", at: 3 };
    await step.run("day3-email", () =>
      aiOutreach(d.org_id, d.contact_id, "Follow-up email three days after first contact; invite a short call. Do not mention any offers.", "email", "Hi {name},\n\nI wanted to follow up and see if I can help. Happy to answer any questions.", `wf002-d3:${d.contact_id}`, "Quick follow-up")
    );

    await step.sleep("day-5", "2d");
    if (await step.run("check-5", replied)) return { stopped: "replied", at: 5 };
    await step.run("day5-whatsapp", () =>
      aiOutreach(d.org_id, d.contact_id, "Gentle last-chance nudge on WhatsApp, low pressure, one clear question.", "whatsapp", "Hi {name}, checking in one last time. Would you like to schedule a quick chat?", `wf002-d5:${d.contact_id}`)
    );

    await step.sleep("day-7", "2d");
    if (await step.run("check-7", replied)) return { stopped: "replied", at: 7 };

    // AI call: consent + DNC + opt-out + calling window (H-05). Outside the window we wait for the next one.
    const gate = await step.run("call-gate", async () => {
      const g = await canDialNow(d.org_id, d.contact_id);
      return { allowed: g.allowed, code: g.code ?? null, retryAt: g.retryAt ? g.retryAt.toISOString() : null };
    });
    if (!gate.allowed && gate.code === "OUTSIDE_CALL_HOURS" && gate.retryAt) {
      await step.sleepUntil("wait-call-window", new Date(gate.retryAt));
    } else if (!gate.allowed) {
      return { completed: true, call: `skipped: ${gate.code}` };
    }
    const called = await step.run("day7-call", async () => {
      const c = await prisma.contacts.findFirst({ where: { id: d.contact_id, org_id: d.org_id, is_active: true } });
      if (!c || (c.lead_score ?? 0) <= 6) return "score too low";
      const again = await canDialNow(d.org_id, d.contact_id); // re-check right before dialing (window may have moved)
      if (!again.allowed) return `skipped: ${again.code}`;
      try {
        await initiateCall(d.org_id, d.contact_id, undefined, { idempotencyKey: `wf002-call:${d.contact_id}`, purpose: "marketing", automated: true });
        return "called";
      } catch (e) {
        if (e instanceof ApiError || e instanceof PlanLimitError) return e.message;
        throw e;
      }
    });
    return { completed: true, call: called };
  }
);

/** WF-003: hot lead alert (score >= 8, crossing the threshold). */
export const wf003HotLead = inngest.createFunction(
  { id: "wf-003-hot-lead-alert", retries: 2 },
  { event: "contact/score.changed" },
  async ({ event, step }) => {
    const d = event.data as Events["contact/score.changed"];
    if (d.score < 8 || (d.previous !== null && d.previous >= 8)) return { skipped: true };

    const c = await step.run("load", async () => {
      const row = await prisma.contacts.findFirst({
        where: { id: d.contact_id, org_id: d.org_id },
        include: { assignee: { select: { id: true, email: true, full_name: true } } },
      });
      return row ? { id: row.id, name: row.full_name, company: row.company, phone: row.phone, reason: row.score_reason, assignee: row.assignee } : null;
    });
    if (!c) return { skipped: "missing" };

    await step.run("slack", () =>
      slackAlert(`:fire: Hot lead: ${c.name}${c.company ? ` (${c.company})` : ""} scored ${d.score}/10. ${c.reason ?? ""} ${appUrl()}/contacts/${c.id}`)
    );

    await step.run("notify-agent", async () => {
      if (!c.assignee) return false;
      // Users have no phone number on file, so the assigned agent is alerted by email.
      try {
        await sendSystemEmail(
          c.assignee.email,
          `Hot lead: ${c.name} (${d.score}/10)`,
          await renderSimple(`Hot lead: ${c.name}`, [`${c.name}${c.company ? ` from ${c.company}` : ""} just scored ${d.score}/10.`, c.reason ?? "Reach out now while interest is high."], { label: "Open contact", url: `${appUrl()}/contacts/${c.id}` })
        );
        return true;
      } catch {
        return false;
      }
    });

    await step.run("create-task", async () => {
      const title = `URGENT: Follow up with hot lead ${c.name} (score ${d.score}/10)`;
      // idempotent on step retry: one open urgent task per contact per score value
      const existing = await prisma.tasks.findFirst({ where: { org_id: d.org_id, contact_id: c.id, title, done: false } });
      if (existing) return;
      await prisma.tasks.create({
        data: {
          org_id: d.org_id,
          contact_id: c.id,
          title,
          due_at: new Date(Date.now() + 60 * 60 * 1000),
          assigned_to: c.assignee?.id ?? null,
        },
      });
    });
    return { alerted: true };
  }
);

/** WF-004: reply handler. Honours STOP keywords (does NOT record consent: an inbound message is not a marketing opt-in) (safety net for the webhook). */
export const wf004ReplyHandler = inngest.createFunction(
  { id: "wf-004-reply-handler", retries: 2 },
  { event: "message/inbound" },
  async ({ event, step }) => {
    const d = event.data as Events["message/inbound"];

    const optedOut = await step.run("opt-out", async () => {
      const m = await prisma.messages.findFirst({
        where: { id: d.message_id, org_id: d.org_id, contact_id: d.contact_id, direction: "inbound" },
        select: { content: true, channel: true },
      });
      if (!m) return false;
      // An inbound message is NOT marketing consent (recordInboundConsent is a no-op); it only opens the 24h service window.
      return applyStopKeyword(d.org_id, d.contact_id, m.channel, m.content);
    });

    const c = await step.run("update-contact", async () => {
      const row = await prisma.contacts.findFirst({
        where: { id: d.contact_id, org_id: d.org_id },
        include: { assignee: { select: { email: true } } },
      });
      if (!row) return null;
      const lastOut = await prisma.messages.findFirst({
        where: { org_id: d.org_id, contact_id: d.contact_id, direction: "outbound", replied_at: null },
        orderBy: { created_at: "desc" },
        select: { id: true },
      });
      if (lastOut) await prisma.messages.update({ where: { id: lastOut.id, org_id: d.org_id }, data: { replied_at: new Date() } });
      if (row.status === "new") await prisma.contacts.update({ where: { id: row.id, org_id: d.org_id }, data: { status: "contacted" } });
      return { id: row.id, name: row.full_name, score: row.lead_score, assigneeEmail: row.assignee?.email ?? null };
    });
    if (!c) return { skipped: "missing" };

    await step.run("stop-automations", async () => {
      await prisma.automation_runs.updateMany({
        where: { contact_id: d.contact_id, status: "running", automation: { org_id: d.org_id } },
        data: { status: "stopped", completed_at: new Date() },
      });
    });
    if (optedOut) return { handled: true, opted_out: true };

    // Deterministic re-score from features (reply count / recency). No LLM here: inbound text is attacker-controlled.
    await step.run("rescore", async () => {
      try {
        await scoreAndSave(d.org_id, d.contact_id, { useLlm: false });
      } catch (e) {
        console.error("[wf-004] rescore failed", e);
      }
    });

    await step.run("notify-assignee", async () => {
      if (!c.assigneeEmail) return false;
      try {
        await sendSystemEmail(c.assigneeEmail, `${c.name} replied`, await renderSimple(`${c.name} replied`, ["A lead you own just replied. Open the inbox to respond."], { label: "Open inbox", url: `${appUrl()}/inbox` }));
        return true;
      } catch {
        return false;
      }
    });
    return { handled: true };
  }
);
