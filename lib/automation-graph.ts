import { z } from "zod";

/**
 * Automation graph (React Flow shape) stored in automations.steps. SOURCE OF TRUTH for the
 * builder UI, the API and the runtime interpreter (inngest/automation-engine.ts).
 *
 * Node types: trigger | condition | delay | action
 *  - condition nodes have two outgoing handles: edge.sourceHandle = "true" | "false"
 *  - all other nodes have a single outgoing handle (sourceHandle null/undefined)
 */
export const ACTION_TYPES = [
  "send_whatsapp",
  "send_email",
  "ai_call",
  "add_tag",
  "update_score",
  "create_task",
  "slack_alert",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const TRIGGER_TYPES = [
  "new_contact",
  "form_submission",
  "tag_added",
  "score_changed",
  "campaign_reply",
  "time_based",
  "webhook",
  "api",
] as const;

export const CONDITION_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "exists"] as const;
/** Condition fields the engine can resolve from the contact. "custom.<key>" reads custom_fields[key]. */
export const CONDITION_FIELDS = [
  "lead_score",
  "status",
  "source",
  "tags",
  "company",
  "email",
  "replied",
  "wa_opt_out",
  "email_opt_out",
] as const;

const position = z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 });

export const TriggerNodeData = z.object({
  trigger_type: z.enum(TRIGGER_TYPES),
  /** e.g. {tag:"hot"} for tag_added, {min_score:8} for score_changed, {form_id} for form_submission, {cron} for time_based */
  config: z.record(z.unknown()).default({}),
});

export const ConditionNodeData = z.object({
  field: z.string().min(1).max(100),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  label: z.string().max(100).optional(),
});

export const DelayNodeData = z.object({
  amount: z.number().int().min(1).max(365),
  unit: z.enum(["hours", "days"]),
  businessHoursOnly: z.boolean().default(false),
});

export const ActionNodeData = z.object({
  action: z.enum(ACTION_TYPES),
  /**
   * send_whatsapp: {message, template_name?, template_params?: string[]}  (merge tags {name},{company})
   * send_email:    {subject, body}
   * ai_call:       {script?}
   * add_tag:       {tag}
   * update_score:  {score?: 1-10 absolute, delta?: number}
   * create_task:   {title, due_in_days?}
   * slack_alert:   {message}
   */
  config: z.record(z.unknown()).default({}),
  label: z.string().max(100).optional(),
});

const base = { id: z.string().min(1).max(64), position };

export const AutomationNode = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("trigger"), data: TriggerNodeData }),
  z.object({ ...base, type: z.literal("condition"), data: ConditionNodeData }),
  z.object({ ...base, type: z.literal("delay"), data: DelayNodeData }),
  z.object({ ...base, type: z.literal("action"), data: ActionNodeData }),
]);

export const AutomationEdge = z.object({
  id: z.string().min(1).max(100),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.enum(["true", "false"]).nullish(),
});

export const AutomationGraph = z.object({
  nodes: z.array(AutomationNode).max(100),
  edges: z.array(AutomationEdge).max(200),
});

export type AutomationGraph = z.infer<typeof AutomationGraph>;
export type AutomationNode = z.infer<typeof AutomationNode>;
export type AutomationEdge = z.infer<typeof AutomationEdge>;
export type NodeData = AutomationNode["data"];
export type TriggerNodeData = z.infer<typeof TriggerNodeData>;
export type ConditionNodeData = z.infer<typeof ConditionNodeData>;
export type DelayNodeData = z.infer<typeof DelayNodeData>;
export type ActionNodeData = z.infer<typeof ActionNodeData>;

export interface GraphValidation {
  valid: boolean;
  errors: string[];
}

/** Structural validation beyond the Zod shape. Empty graphs are allowed only when allowEmpty (drafts). */
export function validateGraph(graph: AutomationGraph, opts: { allowEmpty?: boolean } = {}): GraphValidation {
  const errors: string[] = [];
  const { nodes, edges } = graph;
  if (nodes.length === 0) {
    return opts.allowEmpty ? { valid: true, errors } : { valid: false, errors: ["Graph is empty"] };
  }
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  const triggers = nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) errors.push(`Graph must have exactly one trigger node (found ${triggers.length})`);

  const adj = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  const handlesByNode = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.source)) errors.push(`Edge ${e.id}: unknown source ${e.source}`);
    if (!ids.has(e.target)) errors.push(`Edge ${e.id}: unknown target ${e.target}`);
    if (e.source === e.target) errors.push(`Edge ${e.id}: self loop`);
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    (handlesByNode.get(e.source) ?? handlesByNode.set(e.source, []).get(e.source)!).push(e.sourceHandle ?? "");
  }
  for (const n of nodes) {
    const handles = handlesByNode.get(n.id) ?? [];
    if (n.type === "condition") {
      if (handles.some((h) => h !== "true" && h !== "false")) errors.push(`Condition ${n.id}: edges must use "true"/"false" handles`);
      if (new Set(handles).size !== handles.length) errors.push(`Condition ${n.id}: duplicate true/false branch`);
      if (handles.length === 0) errors.push(`Condition ${n.id}: needs at least one outgoing branch`);
    } else {
      if (handles.some((h) => h !== "")) errors.push(`Node ${n.id}: only condition nodes may use true/false handles`);
      if (handles.length > 1) errors.push(`Node ${n.id}: only one outgoing edge allowed`);
    }
    if (n.type === "trigger" && (incoming.get(n.id) ?? 0) > 0) errors.push("Trigger node cannot have incoming edges");
  }

  // cycle detection (DFS colours)
  const colour = new Map<string, 0 | 1 | 2>();
  let cyclic = false;
  const visit = (id: string) => {
    colour.set(id, 1);
    for (const t of adj.get(id) ?? []) {
      if (!ids.has(t)) continue;
      const c = colour.get(t) ?? 0;
      if (c === 1) cyclic = true;
      else if (c === 0) visit(t);
    }
    colour.set(id, 2);
  };
  for (const id of ids) if ((colour.get(id) ?? 0) === 0) visit(id);
  if (cyclic) errors.push("Graph contains a cycle");

  // reachability from trigger
  if (triggers.length === 1) {
    const seen = new Set<string>();
    const stack = [triggers[0].id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(adj.get(id) ?? []));
    }
    for (const n of nodes) if (!seen.has(n.id)) errors.push(`Node ${n.id} is not connected to the trigger`);
  }
  return { valid: errors.length === 0, errors };
}

/** The single trigger node's trigger_type + config, or null. */
export function getTrigger(graph: AutomationGraph): TriggerNodeData | null {
  const t = graph.nodes.find((n) => n.type === "trigger");
  return t && t.type === "trigger" ? t.data : null;
}

/** Next node ids from `nodeId` (for condition pass the branch result). */
export function nextNodeIds(graph: AutomationGraph, nodeId: string, branch?: boolean): string[] {
  return graph.edges
    .filter((e) => e.source === nodeId && (branch === undefined || (e.sourceHandle ?? "") === String(branch)))
    .map((e) => e.target);
}
