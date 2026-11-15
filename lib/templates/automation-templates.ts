import type { AutomationGraph, AutomationNode } from "@/lib/automation-graph";

type Trig = Extract<AutomationNode, { type: "trigger" }>["data"];
type Step =
  | { t: "delay"; amount: number; unit: "hours" | "days"; bh?: boolean }
  | { t: "wa"; message: string }
  | { t: "email"; subject: string; body: string }
  | { t: "tag"; tag: string }
  | { t: "score"; delta: number }
  | { t: "task"; title: string; days?: number }
  | { t: "slack"; message: string }
  | { t: "call" }
  | { t: "cond"; field: string; operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains"; value: string | number | boolean; yes: Step[]; no?: Step[] };

/** Builds a graph from a trigger + a nested step list; auto-layouts top-down. */
function build(trigger: Trig, steps: Step[]): AutomationGraph {
  const nodes: AutomationNode[] = [];
  const edges: AutomationGraph["edges"] = [];
  let n = 0;
  const id = () => `n${++n}`;
  const add = (node: AutomationNode) => nodes.push(node);

  const walk = (list: Step[], prev: string, handle: "true" | "false" | null, x: number, y: number): void => {
    for (const s of list) {
      const nid = id();
      y += 120;
      if (s.t === "delay") add({ id: nid, type: "delay", position: { x, y }, data: { amount: s.amount, unit: s.unit, businessHoursOnly: s.bh ?? false } });
      else if (s.t === "cond") add({ id: nid, type: "condition", position: { x, y }, data: { field: s.field, operator: s.operator, value: s.value } });
      else {
        const [action, config] =
          s.t === "wa" ? (["send_whatsapp", { message: s.message }] as const)
          : s.t === "email" ? (["send_email", { subject: s.subject, body: s.body }] as const)
          : s.t === "tag" ? (["add_tag", { tag: s.tag }] as const)
          : s.t === "score" ? (["update_score", { delta: s.delta }] as const)
          : s.t === "task" ? (["create_task", { title: s.title, due_in_days: s.days ?? 1 }] as const)
          : s.t === "slack" ? (["slack_alert", { message: s.message }] as const)
          : (["ai_call", {}] as const);
        add({ id: nid, type: "action", position: { x, y }, data: { action, config: { ...config } } });
      }
      edges.push({ id: `e-${prev}-${nid}${handle ? `-${handle}` : ""}`, source: prev, target: nid, sourceHandle: handle });
      prev = nid;
      handle = null;
      if (s.t === "cond") {
        walk(s.yes, nid, "true", x - 160, y);
        if (s.no?.length) walk(s.no, nid, "false", x + 160, y);
        return; // branches terminate the linear chain
      }
    }
  };

  add({ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: trigger });
  walk(steps, "trigger", null, 0, 0);
  return { nodes, edges };
}

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  trigger_type: Trig["trigger_type"];
  graph: AutomationGraph;
}

function tpl(key: string, name: string, description: string, trigger: Trig, steps: Step[]): AutomationTemplate {
  return { key, name, description, trigger_type: trigger.trigger_type, graph: build(trigger, steps) };
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  tpl("new-lead-followup", "New Lead Follow-up", "Welcome every new lead on WhatsApp, follow up after a day, then by email.",
    { trigger_type: "new_contact", config: {} },
    [
      { t: "wa", message: "Hi {name}, thanks for your interest! How can we help you today?" },
      { t: "delay", amount: 1, unit: "days", bh: true },
      { t: "cond", field: "replied", operator: "eq", value: true,
        yes: [{ t: "tag", tag: "engaged" }],
        no: [{ t: "wa", message: "Hi {name}, just checking in. Happy to answer any questions!" }, { t: "delay", amount: 2, unit: "days" }, { t: "email", subject: "Following up, {name}", body: "Hi {name},\n\nWe'd love to help {company}. Reply to this email to chat." }] },
    ]),
  tpl("trial-nurture", "Trial Nurture", "Onboard new trial users over a week with tips and a check-in call.",
    { trigger_type: "tag_added", config: { tag: "trial" } },
    [
      { t: "email", subject: "Welcome to your trial, {name}", body: "Hi {name},\n\nHere is how to get the most from your trial." },
      { t: "delay", amount: 2, unit: "days" },
      { t: "wa", message: "Hi {name}, how is your trial going? Need a hand setting anything up?" },
      { t: "delay", amount: 3, unit: "days" },
      { t: "email", subject: "Your trial is ending soon", body: "Hi {name},\n\nYour trial ends soon. Upgrade to keep your data and automations." },
      { t: "task", title: "Call trial user before expiry", days: 1 },
    ]),
  tpl("post-sale-review", "Post-Sale Review Request", "Ask happy customers for a review a few days after purchase.",
    { trigger_type: "tag_added", config: { tag: "customer" } },
    [
      { t: "delay", amount: 3, unit: "days", bh: true },
      { t: "wa", message: "Hi {name}, thank you for choosing us! Would you share a quick review? It helps a lot." },
      { t: "delay", amount: 3, unit: "days" },
      { t: "email", subject: "How did we do, {name}?", body: "Hi {name},\n\nWe would love your feedback on your recent purchase." },
    ]),
  tpl("hot-lead-alert", "Hot Lead Alert", "Alert the team and call immediately when a lead scores 8 or above.",
    { trigger_type: "score_changed", config: { min_score: 8 } },
    [
      { t: "cond", field: "lead_score", operator: "gte", value: 8,
        yes: [{ t: "tag", tag: "hot" }, { t: "slack", message: "Hot lead: {name} ({company})" }, { t: "task", title: "Call hot lead now", days: 0 }, { t: "call" }] },
    ]),
  tpl("abandoned-cart", "Abandoned Cart", "Recover carts with a reminder, then a nudge with urgency.",
    { trigger_type: "webhook", config: { event: "cart_abandoned" } },
    [
      { t: "delay", amount: 1, unit: "hours" },
      { t: "wa", message: "Hi {name}, you left something in your cart. Complete your order before it sells out!" },
      { t: "delay", amount: 1, unit: "days" },
      { t: "email", subject: "Still thinking it over?", body: "Hi {name},\n\nYour cart is waiting. Reply if you need help." },
    ]),
  tpl("webinar-reminder", "Webinar Reminder", "Remind registrants the day before and an hour before the webinar.",
    { trigger_type: "form_submission", config: { form: "webinar_registration" } },
    [
      { t: "email", subject: "You're registered, {name}!", body: "Hi {name},\n\nYour spot is confirmed. We'll remind you before it starts." },
      { t: "delay", amount: 1, unit: "days" },
      { t: "wa", message: "Hi {name}, reminder: the webinar is coming up soon. See you there!" },
      { t: "delay", amount: 23, unit: "hours" },
      { t: "wa", message: "Starting in about an hour, {name}. Join now!" },
    ]),
  tpl("re-engagement", "Re-engagement", "Win back contacts who went quiet for a while.",
    { trigger_type: "tag_added", config: { tag: "inactive" } },
    [
      { t: "wa", message: "Hi {name}, it's been a while! Anything we can help with?" },
      { t: "delay", amount: 3, unit: "days" },
      { t: "cond", field: "replied", operator: "eq", value: true,
        yes: [{ t: "tag", tag: "re-engaged" }, { t: "score", delta: 2 }],
        no: [{ t: "email", subject: "We miss you, {name}", body: "Hi {name},\n\nHere's what's new since we last spoke." }] },
    ]),
  tpl("appointment-reminder", "Appointment Reminder", "Confirm and remind contacts about their booked appointment.",
    { trigger_type: "webhook", config: { event: "appointment_booked" } },
    [
      { t: "wa", message: "Hi {name}, your appointment is confirmed. Reply to reschedule." },
      { t: "delay", amount: 1, unit: "days" },
      { t: "wa", message: "Reminder {name}: your appointment is tomorrow." },
      { t: "delay", amount: 22, unit: "hours" },
      { t: "wa", message: "Your appointment is in about 2 hours. See you soon!" },
    ]),
  tpl("feedback-request", "Feedback Request", "Collect feedback after support or service completion.",
    { trigger_type: "tag_added", config: { tag: "service-complete" } },
    [
      { t: "delay", amount: 1, unit: "days", bh: true },
      { t: "wa", message: "Hi {name}, how was your experience with us? Reply 1-5 (5 = great)." },
      { t: "delay", amount: 2, unit: "days" },
      { t: "email", subject: "Quick feedback, {name}?", body: "Hi {name},\n\nWe'd value your thoughts on how we did." },
    ]),
  tpl("birthday-festival-greeting", "Birthday/Festival Greeting", "Send warm greetings on birthdays and festivals.",
    { trigger_type: "time_based", config: { schedule: "daily", match: "custom.birthday" } },
    [
      { t: "wa", message: "Warm wishes {name}! Wishing you a wonderful day from all of us." },
      { t: "delay", amount: 1, unit: "days" },
      { t: "email", subject: "A little something for you, {name}", body: "Hi {name},\n\nThank you for being with us. Enjoy a special offer today." },
    ]),
];

export function getTemplate(key: string): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((t) => t.key === key);
}
