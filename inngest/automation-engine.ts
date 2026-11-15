import { inngest, sendEvent, type Events } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { PlanLimitError, incrementUsage } from "@/lib/limits";
import { applyMergeTags } from "@/lib/utils";
import { sendTemplate } from "@/lib/whatsapp";
import { automationKey } from "@/lib/channels/outbound";
import { initiateCall } from "@/lib/voice";
import { setScore } from "@/lib/ai/apply-score";
import { AiError, generateMessage } from "@/lib/ai";
import { routeAiOutbound } from "@/lib/ai/drafts";
import { autoOutreachAllowed, canDialNow, safeContact } from "@/lib/compliance";
import {
  AutomationGraph,
  getTrigger,
  nextNodeIds,
  type ActionNodeData,
  type AutomationNode,
  type ConditionNodeData,
  type DelayNodeData,
} from "@/lib/automation-graph";
import { addTag, emailToContact, slackAlert, waToContact } from "./helpers";

const MAX_STEPS = 100;

// ───────────── trigger dispatch ─────────────
type TriggerType = "new_contact" | "tag_added" | "score_changed" | "campaign_reply";

async function dispatch(orgId: string, contactId: string, type: TriggerType, match: (cfg: Record<string, unknown>) => boolean, payload: Record<string, unknown> = {}) {
  const autos = await prisma.automations.findMany({ where: { org_id: orgId, is_active: true, trigger_type: type } });
  for (const a of autos) {
    const g = AutomationGraph.safeParse(a.steps);
    const cfg = (g.success ? getTrigger(g.data)?.config : null) ?? (a.trigger_config as Record<string, unknown>) ?? {};
    if (!match(cfg)) continue;
    await sendEvent("automation/trigger", { org_id: orgId, automation_id: a.id, contact_id: contactId, payload });
  }
}

export const dispatchNewContact = inngest.createFunction(
  { id: "automation-dispatch-new-contact" },
  { event: "contact/created" },
  async ({ event, step }) => {
    const d = event.data as Events["contact/created"];
    // H-06: new-contact automations do nothing unless org.auto_outreach_enabled AND the contact has recorded consent.
    // Wait briefly so consent capture (CSV attestation / form receiver) can land after the contact row.
    await step.sleep("wait-for-consent", "2m");
    const allowed = await step.run("gate", () => autoOutreachAllowed(d.org_id, d.contact_id));
    if (!allowed) return { skipped: "auto_outreach_disabled_or_no_consent" };
    await step.run("dispatch", () => dispatch(d.org_id, d.contact_id, "new_contact", () => true));
  }
);

export const dispatchTagAdded = inngest.createFunction(
  { id: "automation-dispatch-tag-added" },
  { event: "contact/tag.added" },
  async ({ event, step }) => {
    const d = event.data as Events["contact/tag.added"];
    await step.run("dispatch", () =>
      dispatch(d.org_id, d.contact_id, "tag_added", (cfg) => !cfg.tag || String(cfg.tag).toLowerCase() === d.tag.toLowerCase(), { tag: d.tag })
    );
  }
);

export const dispatchScoreChanged = inngest.createFunction(
  { id: "automation-dispatch-score-changed" },
  { event: "contact/score.changed" },
  async ({ event, step }) => {
    const d = event.data as Events["contact/score.changed"];
    await step.run("dispatch", () =>
      dispatch(d.org_id, d.contact_id, "score_changed", (cfg) => (typeof cfg.min_score !== "number" || d.score >= cfg.min_score) && d.score !== d.previous, { score: d.score })
    );
  }
);

export const dispatchReply = inngest.createFunction(
  { id: "automation-dispatch-reply" },
  { event: "message/inbound" },
  async ({ event, step }) => {
    const d = event.data as Events["message/inbound"];
    await step.run("dispatch", () => dispatch(d.org_id, d.contact_id, "campaign_reply", () => true, { message_id: d.message_id }));
  }
);

// ───────────── interpreter ─────────────
type ContactRow = NonNullable<Awaited<ReturnType<typeof loadContact>>>;

async function loadContact(orgId: string, contactId: string) {
  return prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId, is_active: true } });
}

async function evalCondition(orgId: string, c: ContactRow, cond: ConditionNodeData): Promise<boolean> {
  let actual: unknown;
  if (cond.field === "replied") {
    actual = (await prisma.messages.count({ where: { org_id: orgId, contact_id: c.id, direction: "inbound" } })) > 0;
  } else if (cond.field.startsWith("custom.")) {
    actual = ((c.custom_fields ?? {}) as Record<string, unknown>)[cond.field.slice(7)];
  } else {
    actual = (c as unknown as Record<string, unknown>)[cond.field];
  }
  const v = cond.value;
  const num = (x: unknown) => (typeof x === "number" ? x : Number(x));
  switch (cond.operator) {
    case "exists":
      return actual !== null && actual !== undefined && actual !== "" && !(Array.isArray(actual) && actual.length === 0);
    case "eq":
      return Array.isArray(actual) ? actual.includes(v) : String(actual) === String(v);
    case "neq":
      return Array.isArray(actual) ? !actual.includes(v) : String(actual) !== String(v);
    case "gt":
      return actual != null && num(actual) > num(v);
    case "gte":
      return actual != null && num(actual) >= num(v);
    case "lt":
      return actual != null && num(actual) < num(v);
    case "lte":
      return actual != null && num(actual) <= num(v);
    case "contains":
      return Array.isArray(actual) ? actual.includes(v) : String(actual ?? "").toLowerCase().includes(String(v ?? "").toLowerCase());
    case "not_contains":
      return Array.isArray(actual) ? !actual.includes(v) : !String(actual ?? "").toLowerCase().includes(String(v ?? "").toLowerCase());
  }
}

/** AI-generated message from an automation node: grounded + validated, then draft-or-send per org.ai_approval_required. */
async function aiAction(orgId: string, c: ContactRow, ch: "whatsapp" | "email", goal: string, fallbackSubject: string, nodeId: string, runId: string): Promise<string> {
  try {
    const g = await generateMessage({
      orgId,
      goal,
      contact: { name: c.full_name, company: c.company ?? undefined, email: c.email ?? undefined, phone: c.phone },
      channel: ch,
      tone: "friendly",
      resolveTags: true,
    });
    if (g.needs_info.length || !g.message) return `skipped: AI needs info (${g.needs_info.join(", ") || "empty"})`;
    const r = await routeAiOutbound({
      orgId,
      contactId: c.id,
      channel: ch,
      subject: ch === "email" ? g.subject ?? fallbackSubject : null,
      body: g.message,
      origin: "automation",
      facts: g.facts,
      dedupeKey: `auto:${nodeId}:${c.id}`,
      idempotencyKey: automationKey(runId, nodeId, c.id),
    });
    if (!r.ok) return `skipped: ${r.code ?? r.reason}`;
    return r.drafted ? "drafted for approval" : "sent";
  } catch (e) {
    if (e instanceof AiError) return `skipped: AI failed validation (${e.message})`; // fail closed, never send unvalidated text
    throw e;
  }
}

async function runAction(orgId: string, contactId: string, a: ActionNodeData, nodeId: string, runId: string, retry = false): Promise<string> {
  const cfg = a.config as Record<string, unknown>;
  const s = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");
  const c = await loadContact(orgId, contactId);
  if (!c) return "contact missing";
  try {
    switch (a.action) {
      case "send_whatsapp": {
        if (s("template_name")) {
          const gate = await safeContact(orgId, contactId, "whatsapp", { purpose: "marketing", automated: true });
          if (!gate.allowed) return `skipped: ${gate.code}`;
          const params = Array.isArray(cfg.template_params) ? (cfg.template_params as unknown[]).map((p) => applyMergeTags(String(p), c)) : [];
          await sendTemplate(orgId, c.phone, s("template_name"), params, { contactId, purpose: "marketing", automated: true, idempotencyKey: automationKey(runId, nodeId, contactId) });
          return "sent";
        }
        // Optional AI-written message: config.ai_goal (used only when no static message is set). Goes through the approval gate.
        if (!s("message") && s("ai_goal")) return aiAction(orgId, c, "whatsapp", s("ai_goal"), "", nodeId, runId);
        const r = await waToContact(orgId, contactId, s("message"), automationKey(runId, nodeId, contactId));
        return r.ok ? "sent" : `skipped: ${r.code ?? r.reason}`;
      }
      case "send_email": {
        if (!s("body") && s("ai_goal")) return aiAction(orgId, c, "email", s("ai_goal"), s("subject") || "Update", nodeId, runId);
        const r = await emailToContact(orgId, contactId, s("subject") || "Update", s("body"), automationKey(runId, nodeId, contactId));
        return r.ok ? "sent" : `skipped: ${r.code ?? r.reason}`;
      }
      case "ai_call": {
        const gate = await canDialNow(orgId, contactId);
        if (!gate.allowed) {
          // outside the calling window: ask the engine to wait and retry once instead of dropping the call
          if (gate.code === "OUTSIDE_CALL_HOURS" && gate.retryAt && !retry) return `deferred:${gate.retryAt.toISOString()}`;
          return `skipped: ${gate.code}`;
        }
        await initiateCall(orgId, contactId, s("script") || undefined, { idempotencyKey: automationKey(runId, nodeId, contactId), purpose: "marketing", automated: true });
        return "called";
      }
      case "add_tag": {
        const tag = s("tag");
        if (tag && (await addTag(orgId, contactId, tag))) await sendEvent("contact/tag.added", { org_id: orgId, contact_id: contactId, tag });
        return "tagged";
      }
      case "update_score": {
        const next = typeof cfg.score === "number" ? cfg.score : (c.lead_score ?? 5) + (typeof cfg.delta === "number" ? cfg.delta : 0);
        await setScore(orgId, contactId, next, "Updated by automation", c.lead_score);
        return "scored";
      }
      case "create_task": {
        const days = typeof cfg.due_in_days === "number" ? cfg.due_in_days : 1;
        await prisma.tasks.create({
          data: { org_id: orgId, contact_id: contactId, title: applyMergeTags(s("title") || "Follow up", c), due_at: new Date(Date.now() + days * 86400000), assigned_to: c.assigned_to },
        });
        return "task created";
      }
      case "slack_alert":
        await slackAlert(applyMergeTags(s("message") || "Automation alert for {name}", c));
        return "alerted";
    }
  } catch (e) {
    if (e instanceof ApiError || e instanceof PlanLimitError) return `skipped: ${e.message}`;
    throw e;
  }
}

/** Next 09:00-18:00 IST window start if `from` is outside business hours (Mon-Sat). */
function businessHoursAdjust(from: Date): Date {
  const IST = 5.5 * 3600 * 1000;
  const d = new Date(from.getTime() + IST); // shifted: use UTC getters as IST wall clock
  const inWindow = (x: Date) => x.getUTCDay() !== 0 && x.getUTCHours() >= 9 && x.getUTCHours() < 18;
  if (inWindow(d)) return from;
  const n = new Date(d);
  if (n.getUTCHours() >= 18 || n.getUTCDay() === 0) n.setUTCDate(n.getUTCDate() + 1);
  n.setUTCHours(9, 0, 0, 0);
  while (n.getUTCDay() === 0) n.setUTCDate(n.getUTCDate() + 1);
  return new Date(n.getTime() - IST);
}

export const automationEngine = inngest.createFunction(
  { id: "automation-engine", retries: 2, concurrency: { limit: 10, key: "event.data.org_id" } },
  { event: "automation/trigger" },
  async ({ event, step }) => {
    const d = event.data as Events["automation/trigger"];
    const dryRun = d.test === true;

    const init = await step.run("init", async () => {
      const a = await prisma.automations.findFirst({ where: { id: d.automation_id, org_id: d.org_id } });
      if (!a || (!a.is_active && !dryRun)) return null;
      const g = AutomationGraph.safeParse(a.steps);
      if (!g.success) return null;
      if (!(await loadContact(d.org_id, d.contact_id))) return null;
      const trigger = g.data.nodes.find((n) => n.type === "trigger");
      if (!trigger) return null;
      const run = await prisma.automation_runs.create({ data: { automation_id: a.id, contact_id: d.contact_id, status: "running", current_step: trigger.id } });
      if (!dryRun) {
        await prisma.automations.update({ where: { id: a.id, org_id: d.org_id }, data: { run_count: { increment: 1 }, last_run_at: new Date() } });
        await incrementUsage(d.org_id, "automations_triggered");
      }
      return { runId: run.id, graph: g.data };
    });
    if (!init) return { skipped: true };

    const { runId, graph } = init;
    const byId = new Map<string, AutomationNode>(graph.nodes.map((n) => [n.id, n]));
    const isRunning = async () => (await prisma.automation_runs.findUnique({ where: { id: runId }, select: { status: true } }))?.status === "running";
    const log: string[] = [];

    let current: string | undefined = nextNodeIds(graph, graph.nodes.find((n) => n.type === "trigger")!.id)[0];
    let steps = 0;
    try {
      while (current && steps++ < MAX_STEPS) {
        const nodeId: string = current;
        const node = byId.get(nodeId);
        if (!node) break;

        const alive = await step.run(`enter-${nodeId}`, async () => {
          if (!(await isRunning())) return false;
          await prisma.automation_runs.update({ where: { id: runId }, data: { current_step: nodeId, resume_at: null } });
          return true;
        });
        if (!alive) return { stopped: true, log };

        if (node.type === "condition") {
          const result = await step.run(`cond-${nodeId}`, async () => {
            const c = await loadContact(d.org_id, d.contact_id);
            return c ? evalCondition(d.org_id, c, node.data as ConditionNodeData) : false;
          });
          log.push(`${nodeId}:${result}`);
          current = nextNodeIds(graph, nodeId, result)[0];
        } else if (node.type === "delay") {
          const dl = node.data as DelayNodeData;
          if (!dryRun) {
            const ms = dl.amount * (dl.unit === "days" ? 86400000 : 3600000);
            const resumeAt = await step.run(`resume-${nodeId}`, async () => {
              let at = new Date(Date.now() + ms);
              if (dl.businessHoursOnly) at = businessHoursAdjust(at);
              await prisma.automation_runs.update({ where: { id: runId }, data: { resume_at: at } });
              return at.toISOString();
            });
            await step.sleepUntil(`delay-${nodeId}`, new Date(resumeAt));
          }
          log.push(`${nodeId}:delay`);
          current = nextNodeIds(graph, nodeId)[0];
        } else if (node.type === "action") {
          let res = await step.run(`action-${nodeId}`, async () => (dryRun ? "dry-run" : runAction(d.org_id, d.contact_id, node.data as ActionNodeData, nodeId, runId)));
          if (res.startsWith("deferred:")) {
            await step.sleepUntil(`call-window-${nodeId}`, new Date(res.slice(9)));
            res = await step.run(`action-retry-${nodeId}`, () => runAction(d.org_id, d.contact_id, node.data as ActionNodeData, nodeId, runId, true));
          }
          log.push(`${nodeId}:${res}`);
          current = nextNodeIds(graph, nodeId)[0];
        } else {
          current = nextNodeIds(graph, nodeId)[0];
        }
      }
      await step.run("complete", () =>
        prisma.automation_runs.updateMany({ where: { id: runId, status: "running" }, data: { status: "completed", completed_at: new Date() } })
      );
      return { completed: true, log };
    } catch (e) {
      await prisma.automation_runs.update({
        where: { id: runId },
        data: { status: "failed", error_message: (e instanceof Error ? e.message : "failed").slice(0, 500), completed_at: new Date() },
      });
      throw e;
    }
  }
);
