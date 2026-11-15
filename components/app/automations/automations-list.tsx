"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/fetcher";
import { TRIGGER_LABEL } from "./graph-utils";

interface Automation {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  is_active: boolean;
  run_count: number;
  last_run_at: string | null;
}
interface Template {
  key: string;
  name: string;
  description: string;
  trigger_type: string;
  graph: { nodes: unknown[] };
}

export function AutomationsList() {
  const router = useRouter();
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [toDelete, setToDelete] = React.useState<Automation | null>(null);

  const list = useQuery({ queryKey: ["automations"], queryFn: () => api<Automation[]>("/api/automations") });
  const templates = useQuery({ queryKey: ["automation-templates"], queryFn: () => api<Template[]>("/api/automations/templates"), staleTime: Infinity });

  const onError = (e: unknown) => {
    if (!handleError(e)) toast.error((e as Error).message);
  };

  const toggle = useMutation({
    mutationFn: (a: Automation) => api<Automation>(`/api/automations/${a.id}/toggle`, { method: "PATCH", json: { is_active: !a.is_active } }),
    onSuccess: (r) => {
      toast.success(r.is_active ? "Automation activated" : "Automation paused");
      void qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/automations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Automation deleted");
      setToDelete(null);
      void qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError,
  });
  const fromTemplate = useMutation({
    mutationFn: (key: string) => api<Automation>("/api/automations/templates", { method: "POST", json: { key } }),
    onSuccess: (r) => {
      toast.success("Template added. Review it, then activate.");
      void qc.invalidateQueries({ queryKey: ["automations"] });
      router.push(`/automations/${r.id}`);
    },
    onError,
  });

  return (
    <div>
      <PageHeader
        title="Automations"
        description="Trigger-based workflows that follow up with leads automatically."
        actions={
          <Button asChild>
            <Link href="/automations/new">
              <Plus className="mr-1 h-4 w-4" /> New automation
            </Link>
          </Button>
        }
      />

      {list.isError ? (
        <div className="rounded-xl border p-6 text-center text-sm">
          <p className="text-destructive">{(list.error as Error).message}</p>
          <Button className="mt-3" variant="outline" onClick={() => list.refetch()}>Retry</Button>
        </div>
      ) : list.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
      ) : list.data && list.data.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.map((a) => (
            <Card key={a.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/automations/${a.id}`} className="block truncate font-medium hover:underline">{a.name}</Link>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{a.description ?? "No description"}</p>
                  </div>
                  <Switch
                    checked={a.is_active}
                    disabled={toggle.isPending && toggle.variables?.id === a.id}
                    onCheckedChange={() => toggle.mutate(a)}
                    aria-label={a.is_active ? "Pause automation" : "Activate automation"}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">{TRIGGER_LABEL[a.trigger_type] ?? a.trigger_type}</Badge>
                  <Badge variant={a.is_active ? "success" : "muted"}>{a.is_active ? "Active" : "Paused"}</Badge>
                  <span className="text-muted-foreground">{a.run_count.toLocaleString("en-IN")} runs</span>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">{a.last_run_at ? `Last run ${new Date(a.last_run_at).toLocaleDateString()}` : "Never run"}</p>
                  <div className="flex gap-1">
                    <Button asChild size="icon" variant="ghost" aria-label="Edit"><Link href={`/automations/${a.id}`}><Pencil className="h-4 w-4" /></Link></Button>
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setToDelete(a)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Workflow className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No automations yet</p>
          <p className="text-sm text-muted-foreground">Start from a template below or build one from scratch.</p>
        </div>
      )}

      <h2 className="mb-3 mt-10 text-lg font-semibold">Start from a template</h2>
      {templates.isError ? (
        <p className="text-sm text-destructive">{(templates.error as Error).message}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {templates.isLoading
            ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)
            : templates.data?.map((t) => (
                <Card key={t.key}>
                  <CardContent className="flex h-full flex-col gap-2 p-4">
                    <p className="font-medium">{t.name}</p>
                    <p className="flex-1 text-xs text-muted-foreground">{t.description}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{t.graph.nodes.length} steps · {TRIGGER_LABEL[t.trigger_type] ?? t.trigger_type}</span>
                      <Button size="sm" variant="outline" disabled={fromTemplate.isPending} onClick={() => fromTemplate.mutate(t.key)}>
                        Use template
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
        </div>
      )}

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete automation?</DialogTitle>
            <DialogDescription>
              “{toDelete?.name}” and its run history will be permanently deleted. Only admins can do this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>Cancel</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => toDelete && remove.mutate(toDelete.id)}>
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
