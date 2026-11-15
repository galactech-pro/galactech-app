"use client";

import "reactflow/dist/style.css";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from "reactflow";
import { ArrowLeft, Clock, FlaskConical, GitBranch, Play, Save, Zap } from "lucide-react";
import { toast } from "sonner";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { AutomationGraph } from "@/lib/automation-graph";
import { api } from "@/lib/fetcher";
import { ConfigPanel } from "./config-panel";
import { defaultData, fromGraph, newNodeId, toGraph, validateFlow, type FlowNode, type NodeKind } from "./graph-utils";
import { nodeTypes, StatsContext, type StepStat } from "./nodes";

interface AutomationRow {
  id: string;
  name: string;
  is_active: boolean;
  steps: unknown;
}
interface AnalyticsRes {
  total_runs: number;
  completion_rate: number;
  steps: ({ node_id: string } & StepStat)[];
}
interface ContactLite { id: string; full_name: string; phone: string }

const PALETTE: { kind: NodeKind; label: string; icon: React.ReactNode }[] = [
  { kind: "trigger", label: "Trigger", icon: <Play className="h-4 w-4 text-green-700" /> },
  { kind: "condition", label: "Condition", icon: <GitBranch className="h-4 w-4 text-amber-700" /> },
  { kind: "delay", label: "Delay", icon: <Clock className="h-4 w-4 text-blue-700" /> },
  { kind: "action", label: "Action", icon: <Zap className="h-4 w-4 text-violet-700" /> },
];

function TestDialog({ open, onClose, run }: { open: boolean; onClose: () => void; run: (contactId: string) => Promise<void> }) {
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const contacts = useQuery({
    queryKey: ["automation-test-contacts", q],
    queryFn: () => api<{ items: ContactLite[] }>(`/api/contacts?page_size=8${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Test run</DialogTitle>
          <DialogDescription>Runs this automation for one contact. Real messages are sent, so pick your own test contact. Unsaved changes are saved first.</DialogDescription>
        </DialogHeader>
        <Input placeholder="Search contacts" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
          {contacts.isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : contacts.isError ? (
            <p className="p-3 text-sm text-destructive">{(contacts.error as Error).message}</p>
          ) : contacts.data?.items.length ? (
            contacts.data.items.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.full_name}</p>
                  <p className="text-xs text-muted-foreground">{c.phone}</p>
                </div>
                <Button
                  size="sm"
                  disabled={!!pending}
                  onClick={async () => {
                    setPending(c.id);
                    try {
                      await run(c.id);
                      onClose();
                    } finally {
                      setPending(null);
                    }
                  }}
                >
                  {pending === c.id ? "Queuing…" : "Run"}
                </Button>
              </div>
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">No contacts found.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BuilderInner({ id }: { id?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode["data"]>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [name, setName] = React.useState("Untitled automation");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [testOpen, setTestOpen] = React.useState(false);
  const [showStats, setShowStats] = React.useState(false);
  const loadedRef = React.useRef(false);

  const existing = useQuery({ queryKey: ["automation", id], queryFn: () => api<AutomationRow>(`/api/automations/${id}`), enabled: !!id });
  const stats = useQuery({ queryKey: ["automation-analytics", id], queryFn: () => api<AnalyticsRes>(`/api/automations/${id}/analytics`), enabled: !!id && showStats });

  React.useEffect(() => {
    if (!existing.data || loadedRef.current) return;
    loadedRef.current = true;
    setName(existing.data.name);
    const parsed = AutomationGraph.safeParse(existing.data.steps);
    if (parsed.success) {
      const g = fromGraph(parsed.data);
      setNodes(g.nodes);
      setEdges(g.edges);
    } else {
      toast.error("This automation's graph could not be read; starting empty.");
    }
  }, [existing.data, setNodes, setEdges]);

  const statMap = React.useMemo(() => {
    if (!showStats || !stats.data) return null;
    return Object.fromEntries(stats.data.steps.map((s) => [s.node_id, s]));
  }, [showStats, stats.data]);

  const addNode = React.useCallback(
    (kind: NodeKind, position?: { x: number; y: number }) => {
      if (kind === "trigger" && nodes.some((n) => n.type === "trigger")) {
        toast.error("An automation can only have one trigger");
        return;
      }
      const nid = newNodeId(kind);
      const pos = position ?? { x: 80 + (nodes.length % 4) * 40, y: 40 + nodes.length * 110 };
      setNodes((ns) => [...ns, { id: nid, type: kind, position: pos, data: defaultData(kind) }]);
      setSelectedId(nid);
    },
    [nodes, setNodes]
  );

  const onConnect = React.useCallback(
    (c: Connection) => {
      setEdges((es) => {
        // one outgoing edge per handle
        const rest = es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)));
        return addEdge({ ...c, id: `e-${c.source}-${c.target}-${c.sourceHandle ?? "out"}` }, rest);
      });
    },
    [setEdges]
  );

  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    const kind = ev.dataTransfer.getData("application/omni-node") as NodeKind;
    if (!kind) return;
    addNode(kind, rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
  };

  const deleteNode = (nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    setSelectedId(null);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      const errs = validateFlow(nodes, edges as Edge[]);
      setErrors(errs);
      if (errs.length) throw new Error(`Fix ${errs.length} issue${errs.length === 1 ? "" : "s"} before saving`);
      const steps = toGraph(nodes, edges);
      if (id) {
        await api(`/api/automations/${id}`, { method: "PATCH", json: { name, steps } });
        return id;
      }
      const row = await api<{ id: string }>("/api/automations", { method: "POST", json: { name, steps } });
      return row.id;
    },
    onSuccess: (rid) => {
      toast.success("Automation saved");
      void qc.invalidateQueries({ queryKey: ["automations"] });
      void qc.invalidateQueries({ queryKey: ["automation", rid] });
      if (!id) router.replace(`/automations/${rid}`);
    },
    onError: (e) => {
      if (!handleError(e)) toast.error((e as Error).message);
    },
  });

  const runTest = async (contactId: string) => {
    try {
      const rid = await save.mutateAsync();
      await api(`/api/automations/${rid}/test`, { method: "POST", json: { contact_id: contactId } });
      toast.success("Test run queued. Enable analytics overlay to follow progress.");
    } catch (e) {
      if (!handleError(e)) toast.error((e as Error).message);
      throw e;
    }
  };

  if (id && existing.isLoading) return <Skeleton className="h-[60vh] w-full" />;
  if (id && existing.isError) {
    return (
      <div className="rounded-xl border p-6 text-center text-sm">
        <p className="text-destructive">{(existing.error as Error).message}</p>
        <Button asChild variant="outline" className="mt-3"><Link href="/automations">Back to automations</Link></Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back"><Link href="/automations"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <Input className="w-full max-w-xs" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-label="Automation name" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {id ? (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={showStats} onCheckedChange={setShowStats} /> Analytics
            </label>
          ) : null}
          <Button variant="outline" onClick={() => setTestOpen(true)} disabled={nodes.length === 0}>
            <FlaskConical className="mr-1 h-4 w-4" /> Test run
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            <Save className="mr-1 h-4 w-4" /> {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {errors.length ? (
        <ul className="list-disc rounded-lg border border-destructive/40 bg-destructive/5 p-3 pl-7 text-xs text-destructive">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      ) : null}
      {showStats && stats.isError ? <p className="text-xs text-destructive">{(stats.error as Error).message}</p> : null}
      {showStats && stats.data ? (
        <p className="text-xs text-muted-foreground">
          {stats.data.total_runs} runs, {stats.data.completion_rate}% completed. Each node shows contacts reached and drop-off.
        </p>
      ) : null}

      <div className="flex h-[calc(100vh-12rem)] min-h-[520px] flex-col overflow-hidden rounded-xl border bg-card md:flex-row">
        <aside className="flex shrink-0 gap-2 border-b p-2 md:w-40 md:flex-col md:border-b-0 md:border-r md:p-3">
          <p className="hidden text-xs font-medium text-muted-foreground md:block">Drag or click to add</p>
          {PALETTE.map((p) => (
            <button
              key={p.kind}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/omni-node", p.kind);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => addNode(p.kind)}
              className="flex flex-1 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm hover:bg-muted md:flex-none"
            >
              {p.icon} {p.label}
            </button>
          ))}
        </aside>

        <div className="relative min-h-[320px] flex-1" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}>
          <StatsContext.Provider value={statMap}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              deleteKeyCode={["Backspace", "Delete"]}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} />
              <Controls />
              <MiniMap pannable zoomable className="!hidden md:!block" />
            </ReactFlow>
          </StatsContext.Provider>
          {nodes.length === 0 ? (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Start by adding a Trigger from the palette, then connect actions, delays and conditions.
            </p>
          ) : null}
        </div>

        <aside className="max-h-72 shrink-0 overflow-y-auto border-t md:max-h-none md:w-72 md:border-l md:border-t-0">
          <ConfigPanel node={selected} onChange={(nid, data) => setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data } : n)))} onDelete={deleteNode} />
        </aside>
      </div>
      <Label className="sr-only">Automation builder</Label>
      <TestDialog open={testOpen} onClose={() => setTestOpen(false)} run={runTest} />
    </div>
  );
}

export function AutomationBuilder({ id }: { id?: string }) {
  return (
    <ReactFlowProvider>
      <BuilderInner id={id} />
    </ReactFlowProvider>
  );
}
