"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_TYPES, CONDITION_FIELDS, CONDITION_OPERATORS, TRIGGER_TYPES, type NodeData } from "@/lib/automation-graph";
import { ACTION_LABEL, TRIGGER_LABEL, type FlowNode } from "./graph-utils";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const MERGE_HINT = "Merge tags: {name}, {company}";

export function ConfigPanel({ node, onChange, onDelete }: { node: FlowNode | null; onChange: (id: string, data: NodeData) => void; onDelete: (id: string) => void }) {
  if (!node) {
    return <p className="p-4 text-sm text-muted-foreground">Select a node to edit its settings, or add one from the palette.</p>;
  }
  const d = node.data;
  const set = (patch: Record<string, unknown>) => onChange(node.id, { ...d, ...patch } as NodeData);
  const setCfg = (key: string, value: unknown) => {
    const cfg = { ...(d as { config: Record<string, unknown> }).config, [key]: value };
    onChange(node.id, { ...d, config: cfg } as NodeData);
  };
  const str = (cfg: Record<string, unknown>, k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : cfg[k] != null ? String(cfg[k]) : "");
  const numOrUndef = (v: string) => (v === "" ? undefined : Number(v));

  let body: React.ReactNode = null;

  if (node.type === "trigger" && "trigger_type" in d) {
    const c = d.config;
    body = (
      <>
        <Field label="Trigger type">
          <Select value={d.trigger_type} onValueChange={(v) => set({ trigger_type: v, config: {} })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TRIGGER_TYPES.map((t) => <SelectItem key={t} value={t}>{TRIGGER_LABEL[t]}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        {d.trigger_type === "tag_added" ? (
          <Field label="Tag"><Input value={str(c, "tag")} onChange={(e) => setCfg("tag", e.target.value)} placeholder="hot" /></Field>
        ) : null}
        {d.trigger_type === "score_changed" ? (
          <Field label="Minimum score (1-10)"><Input type="number" min={1} max={10} value={str(c, "min_score")} onChange={(e) => setCfg("min_score", numOrUndef(e.target.value))} /></Field>
        ) : null}
        {d.trigger_type === "form_submission" ? (
          <Field label="Form ID (optional)"><Input value={str(c, "form_id")} onChange={(e) => setCfg("form_id", e.target.value)} /></Field>
        ) : null}
        {d.trigger_type === "time_based" ? (
          <Field label="Cron expression" hint="e.g. 0 9 * * 1 (Mondays 9am)"><Input value={str(c, "cron")} onChange={(e) => setCfg("cron", e.target.value)} placeholder="0 9 * * 1" /></Field>
        ) : null}
        {d.trigger_type === "webhook" || d.trigger_type === "api" ? (
          <p className="text-xs text-muted-foreground">Starts when an external system calls your {d.trigger_type === "api" ? "API key endpoint" : "webhook"}.</p>
        ) : null}
      </>
    );
  } else if (node.type === "condition" && "field" in d) {
    body = (
      <>
        <Field label="Label (optional)"><Input value={d.label ?? ""} maxLength={100} onChange={(e) => set({ label: e.target.value })} /></Field>
        <Field label="Field" hint='Use "custom.<key>" for custom fields.'>
          <Input list="cond-fields" value={d.field} onChange={(e) => set({ field: e.target.value })} />
          <datalist id="cond-fields">{CONDITION_FIELDS.map((f) => <option key={f} value={f} />)}</datalist>
        </Field>
        <Field label="Operator">
          <Select value={d.operator} onValueChange={(v) => set({ operator: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{CONDITION_OPERATORS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {d.operator !== "exists" ? (
          <Field label="Value" hint="Numbers and true/false are detected automatically.">
            <Input value={d.value === undefined ? "" : String(d.value)} onChange={(e) => set({ value: e.target.value })} />
          </Field>
        ) : null}
      </>
    );
  } else if (node.type === "delay" && "amount" in d) {
    body = (
      <>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Wait for"><Input type="number" min={1} max={365} value={Number.isFinite(d.amount) ? d.amount : ""} onChange={(e) => set({ amount: Math.trunc(Number(e.target.value)) })} /></Field>
          <Field label="Unit">
            <Select value={d.unit} onValueChange={(v) => set({ unit: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hours">Hours</SelectItem>
                <SelectItem value="days">Days</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">Business hours only</Label>
          <Switch checked={d.businessHoursOnly} onCheckedChange={(v) => set({ businessHoursOnly: v })} />
        </div>
      </>
    );
  } else if (node.type === "action" && "action" in d) {
    const c = d.config;
    body = (
      <>
        <Field label="Action">
          <Select value={d.action} onValueChange={(v) => set({ action: v, config: {} })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{ACTION_TYPES.map((a) => <SelectItem key={a} value={a}>{ACTION_LABEL[a]}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Label (optional)"><Input value={d.label ?? ""} maxLength={100} onChange={(e) => set({ label: e.target.value })} /></Field>
        {d.action === "send_whatsapp" ? (
          <>
            <Field label="Message" hint={MERGE_HINT}><Textarea rows={4} value={str(c, "message")} onChange={(e) => setCfg("message", e.target.value)} /></Field>
            <Field label="Template name (optional)" hint="For messages outside the 24h window."><Input value={str(c, "template_name")} onChange={(e) => setCfg("template_name", e.target.value)} /></Field>
            <Field label="Template params (comma separated)">
              <Input value={Array.isArray(c.template_params) ? (c.template_params as string[]).join(", ") : ""} onChange={(e) => setCfg("template_params", e.target.value.split(","))} />
            </Field>
          </>
        ) : null}
        {d.action === "send_email" ? (
          <>
            <Field label="Subject" hint={MERGE_HINT}><Input value={str(c, "subject")} onChange={(e) => setCfg("subject", e.target.value)} /></Field>
            <Field label="Body" hint={MERGE_HINT}><Textarea rows={6} value={str(c, "body")} onChange={(e) => setCfg("body", e.target.value)} /></Field>
          </>
        ) : null}
        {d.action === "ai_call" ? (
          <Field label="Custom script (optional)" hint="Leave empty to auto-generate per contact."><Textarea rows={6} value={str(c, "script")} onChange={(e) => setCfg("script", e.target.value)} /></Field>
        ) : null}
        {d.action === "add_tag" ? <Field label="Tag"><Input value={str(c, "tag")} onChange={(e) => setCfg("tag", e.target.value)} /></Field> : null}
        {d.action === "update_score" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Set score (1-10)"><Input type="number" min={1} max={10} value={str(c, "score")} onChange={(e) => setCfg("score", numOrUndef(e.target.value))} /></Field>
            <Field label="Or change by"><Input type="number" value={str(c, "delta")} onChange={(e) => setCfg("delta", numOrUndef(e.target.value))} /></Field>
          </div>
        ) : null}
        {d.action === "create_task" ? (
          <>
            <Field label="Task title"><Input value={str(c, "title")} onChange={(e) => setCfg("title", e.target.value)} /></Field>
            <Field label="Due in (days)"><Input type="number" min={0} value={str(c, "due_in_days")} onChange={(e) => setCfg("due_in_days", numOrUndef(e.target.value))} /></Field>
          </>
        ) : null}
        {d.action === "slack_alert" ? <Field label="Message" hint={MERGE_HINT}><Textarea rows={3} value={str(c, "message")} onChange={(e) => setCfg("message", e.target.value)} /></Field> : null}
      </>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize">{node.type} settings</h3>
        {node.type !== "trigger" ? (
          <Button variant="ghost" size="icon" aria-label="Delete node" onClick={() => onDelete(node.id)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        ) : null}
      </div>
      {body}
    </div>
  );
}
