"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable } from "@/components/app/data-table";
import { api } from "@/lib/fetcher";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { ConfirmDialog } from "./confirm-dialog";
import { CopyButton } from "./connections-tab";
import type { OrgSettings } from "./types";

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}
interface CreatedKey { id: string; name: string; key_prefix: string; expires_at: string | null; key: string }

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

export function ApiKeysTab({ org }: { org: OrgSettings }) {
  const pro = org.plan === "pro";
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [days, setDays] = React.useState("");
  const [created, setCreated] = React.useState<CreatedKey | null>(null);
  const [revoke, setRevoke] = React.useState<ApiKeyRow | null>(null);

  const list = useQuery({ queryKey: ["api-keys"], queryFn: () => api<ApiKeyRow[]>("/api/keys"), enabled: pro });
  const create = useMutation({
    mutationFn: () => api<CreatedKey>("/api/keys", { method: "POST", json: { name: name.trim(), ...(days ? { expires_in_days: Number(days) } : {}) } }),
    onSuccess: (k) => {
      setCreating(false);
      setName("");
      setDays("");
      setCreated(k);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e: Error) => { if (!handleError(e)) toast.error(e.message); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/keys?id=${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("API key revoked");
      setRevoke(null);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!pro) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> API access</CardTitle>
          <CardDescription>Programmatic access to your contacts and campaigns is available on the Pro plan.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild><Link href="/billing"><Sparkles /> Upgrade to Pro</Link></Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>API keys</CardTitle>
          <CardDescription>Send keys as a bearer token. Keys are shown once on creation; only a hash is stored. Max 20 keys.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}><Plus /> New key</Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isError ? (
          <div className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
            {(list.error as Error).message}{" "}
            <Button variant="link" className="h-auto p-0" onClick={() => list.refetch()}>Retry</Button>
          </div>
        ) : (
          <DataTable<ApiKeyRow>
            loading={list.isLoading}
            rows={list.data}
            rowKey={(r) => r.id}
            empty="No API keys yet."
            columns={[
              { key: "name", header: "Name", cell: (r) => <span className="font-medium">{r.name}</span> },
              { key: "prefix", header: "Key", cell: (r) => <code className="text-xs">{r.key_prefix}…</code> },
              { key: "used", header: "Last used", cell: (r) => <span className="text-muted-foreground">{fmt(r.last_used_at)}</span>, className: "hidden sm:table-cell", headClassName: "hidden sm:table-cell" },
              { key: "exp", header: "Expires", cell: (r) => <span className="text-muted-foreground">{r.expires_at ? fmt(r.expires_at) : "Never"}</span>, className: "hidden md:table-cell", headClassName: "hidden md:table-cell" },
              { key: "act", header: "", cell: (r) => <Button variant="ghost" size="icon" aria-label="Revoke key" onClick={() => setRevoke(r)}><Trash2 className="h-4 w-4 text-destructive" /></Button>, className: "w-12" },
            ]}
          />
        )}
      </CardContent>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>Give the key a name so you can recognise it later.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="kn">Name</Label>
              <Input id="kn" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Zapier integration" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kd">Expires in (days, optional)</Label>
              <Input id="kd" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="animate-spin" /> : null} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Copy your API key now</DialogTitle>
            <DialogDescription>This is the only time the full key is shown. Store it somewhere safe.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={created?.key ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton value={created?.key ?? ""} />
          </div>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>I have saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title="Revoke API key?"
        description={`Anything using "${revoke?.name ?? ""}" will stop working immediately. This cannot be undone.`}
        confirmLabel="Revoke"
        destructive
        loading={del.isPending}
        onConfirm={() => revoke && del.mutate(revoke.id)}
      />
    </Card>
  );
}
