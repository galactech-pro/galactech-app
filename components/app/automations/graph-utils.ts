import type { Edge, Node } from "reactflow";
import {
  AutomationGraph,
  validateGraph,
  type ActionNodeData,
  type AutomationNode,
  type NodeData,
} from "@/lib/automation-graph";

export type FlowNode = Node<NodeData>;
export type NodeKind = "trigger" | "condition" | "delay" | "action";

export const ACTION_LABEL: Record<string, string> = {
  send_whatsapp: "Send WhatsApp",
  send_email: "Send email",
  ai_call: "AI voice call",
  add_tag: "Add tag",
  update_score: "Update score",
  create_task: "Create task",
  slack_alert: "Slack alert",
};

export const TRIGGER_LABEL: Record<string, string> = {
  new_contact: "New contact",
  form_submission: "Form submission",
  tag_added: "Tag added",
  score_changed: "Score changed",
  campaign_reply: "Campaign reply",
  time_based: "Time based",
  webhook: "Webhook",
  api: "API call",
};

export function defaultData(kind: NodeKind): NodeData {
  switch (kind) {
    case "trigger":
      return { trigger_type: "new_contact", config: {} };
    case "condition":
      return { field: "lead_score", operator: "gte", value: "7" };
    case "delay":
      return { amount: 1, unit: "days", businessHoursOnly: false };
    case "action":
      return { action: "send_whatsapp", config: { message: "" } };
  }
}

export function newNodeId(kind: NodeKind): string {
  return kind === "trigger" ? "trigger" : `${kind}_${Math.random().toString(36).slice(2, 8)}`;
}

export function fromGraph(g: AutomationGraph): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
    edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

function coerceValue(v: unknown): string | number | boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return v as number | boolean;
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function cleanConfig(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === "" || v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const arr = v.map((x) => String(x).trim()).filter(Boolean);
      if (arr.length) out[k] = arr;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function toGraph(nodes: FlowNode[], edges: Edge[]): AutomationGraph {
  return {
    nodes: nodes.map((n) => {
      const position = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      const d = n.data;
      let data: NodeData = d;
      if (n.type === "condition" && "field" in d) {
        const value = d.operator === "exists" ? undefined : coerceValue(d.value);
        data = { field: d.field, operator: d.operator, ...(value !== undefined ? { value } : {}), ...(d.label ? { label: d.label } : {}) };
      } else if (n.type === "action" && "action" in d) {
        data = { action: d.action, config: cleanConfig(d.config), ...(d.label ? { label: d.label } : {}) } as ActionNodeData;
      } else if (n.type === "trigger" && "trigger_type" in d) {
        data = { trigger_type: d.trigger_type, config: cleanConfig(d.config) };
      }
      return { id: n.id, type: n.type, position, data } as AutomationNode;
    }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle === "true" || e.sourceHandle === "false" ? e.sourceHandle : null })),
  };
}

const need = (c: Record<string, unknown>, k: string) => typeof c[k] === "string" && (c[k] as string).trim().length > 0;

/** Client-side validation: Zod shape + validateGraph (same as the API) + required config fields. */
export function validateFlow(nodes: FlowNode[], edges: Edge[], allowEmpty = true): string[] {
  const graph = toGraph(nodes, edges);
  const errors: string[] = [];
  const parsed = AutomationGraph.safeParse(graph);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 5)) errors.push(`${i.path.join(".")}: ${i.message}`);
    return errors;
  }
  errors.push(...validateGraph(parsed.data, { allowEmpty }).errors);
  for (const n of parsed.data.nodes) {
    const name = `${n.type} node ${n.id}`;
    if (n.type === "trigger") {
      const c = n.data.config;
      if (n.data.trigger_type === "tag_added" && !need(c, "tag")) errors.push(`${name}: tag is required`);
      if (n.data.trigger_type === "time_based" && !need(c, "cron")) errors.push(`${name}: cron expression is required`);
    } else if (n.type === "condition") {
      if (n.data.operator !== "exists" && n.data.value === undefined) errors.push(`${name}: value is required`);
    } else if (n.type === "action") {
      const c = n.data.config;
      switch (n.data.action) {
        case "send_whatsapp":
          if (!need(c, "message") && !need(c, "template_name")) errors.push(`${name}: message or template name is required`);
          break;
        case "send_email":
          if (!need(c, "subject") || !need(c, "body")) errors.push(`${name}: subject and body are required`);
          break;
        case "add_tag":
          if (!need(c, "tag")) errors.push(`${name}: tag is required`);
          break;
        case "update_score":
          if (c.score === undefined && c.delta === undefined) errors.push(`${name}: set a score or a delta`);
          break;
        case "create_task":
          if (!need(c, "title")) errors.push(`${name}: title is required`);
          break;
        case "slack_alert":
          if (!need(c, "message")) errors.push(`${name}: message is required`);
          break;
      }
    }
  }
  return errors;
}
