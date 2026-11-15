"use client";

import * as React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { Clock, GitBranch, Play, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NodeData } from "@/lib/automation-graph";
import { ACTION_LABEL, TRIGGER_LABEL } from "./graph-utils";

export interface StepStat {
  contacts_reached: number;
  currently_here: number;
  drop_off_pct: number;
}
export const StatsContext = React.createContext<Record<string, StepStat> | null>(null);

function Shell({ id, selected, icon, title, subtitle, tone, children }: { id: string; selected: boolean; icon: React.ReactNode; title: string; subtitle?: string; tone: string; children?: React.ReactNode }) {
  const stats = React.useContext(StatsContext)?.[id];
  return (
    <div className={cn("w-56 rounded-lg border bg-card text-card-foreground shadow-sm", selected && "ring-2 ring-primary")}>
      <div className="flex items-start gap-2 p-3">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", tone)}>{icon}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          {subtitle ? <p className="line-clamp-2 break-words text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {children}
      {stats ? (
        <div className="flex justify-between rounded-b-xl border-t bg-muted px-3 py-1 text-[11px] text-muted-foreground">
          <span>{stats.contacts_reached} reached</span>
          <span>{stats.drop_off_pct}% drop-off</span>
        </div>
      ) : null}
    </div>
  );
}

export function TriggerNode({ id, data, selected }: NodeProps<NodeData>) {
  const d = data as Extract<NodeData, { trigger_type: unknown }>;
  return (
    <>
      <Shell id={id} selected={selected} tone="bg-green-100 text-green-700" icon={<Play className="h-4 w-4" />} title="Trigger" subtitle={TRIGGER_LABEL[d.trigger_type]} />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export function ConditionNode({ id, data, selected }: NodeProps<NodeData>) {
  const d = data as Extract<NodeData, { field: unknown }>;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Shell
        id={id}
        selected={selected}
        tone="bg-amber-100 text-amber-700"
        icon={<GitBranch className="h-4 w-4" />}
        title={d.label || "Condition"}
        subtitle={`${d.field} ${d.operator}${d.operator === "exists" ? "" : ` ${d.value ?? ""}`}`}
      >
        <div className="flex justify-between px-4 pb-1 text-[10px] font-medium">
          <span className="text-green-700">True</span>
          <span className="text-red-700">False</span>
        </div>
      </Shell>
      <Handle type="source" id="true" position={Position.Bottom} style={{ left: "25%", background: "#16a34a" }} />
      <Handle type="source" id="false" position={Position.Bottom} style={{ left: "75%", background: "#dc2626" }} />
    </>
  );
}

export function DelayNode({ id, data, selected }: NodeProps<NodeData>) {
  const d = data as Extract<NodeData, { amount: unknown }>;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Shell id={id} selected={selected} tone="bg-blue-100 text-blue-700" icon={<Clock className="h-4 w-4" />} title="Wait" subtitle={`${d.amount} ${d.unit}${d.businessHoursOnly ? " (business hours)" : ""}`} />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export function ActionNode({ id, data, selected }: NodeProps<NodeData>) {
  const d = data as Extract<NodeData, { action: unknown }>;
  const c = d.config;
  const sub = (c.message ?? c.subject ?? c.tag ?? c.title ?? "") as string;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Shell id={id} selected={selected} tone="bg-violet-100 text-violet-700" icon={<Zap className="h-4 w-4" />} title={d.label || ACTION_LABEL[d.action]} subtitle={d.label ? ACTION_LABEL[d.action] : String(sub)} />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

export const nodeTypes = { trigger: TriggerNode, condition: ConditionNode, delay: DelayNode, action: ActionNode };
