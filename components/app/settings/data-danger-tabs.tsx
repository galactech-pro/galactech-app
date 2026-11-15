"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/fetcher";
import { ConfirmDialog } from "./confirm-dialog";

const TYPES = ["contacts", "campaigns", "calls"] as const;

export function DataExportTab() {
  const [busy, setBusy] = React.useState<string | null>(null);
  async function download(type: (typeof TYPES)[number]) {
    setBusy(type);
    try {
      const res = await fetch(`/api/settings/export?type=${type}`);
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? "Export failed");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${type}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data export</CardTitle>
        <CardDescription>Download your data as CSV. Exports are recorded in the audit log.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <Button key={t} variant="outline" disabled={busy !== null} onClick={() => download(t)}>
            {busy === t ? <Loader2 className="animate-spin" /> : <Download />} Export {t}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

export function DangerTab() {
  const [open, setOpen] = React.useState(false);
  const cancel = useMutation({
    mutationFn: () => api<{ current_period_end: string | null }>("/api/billing/cancel", { method: "POST" }),
    onSuccess: () => {
      toast.success("Subscription will cancel at the end of the billing period");
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>Irreversible or disruptive actions.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Cancel subscription</p>
            <p className="text-muted-foreground">Your plan stays active until the end of the paid period, then downgrades to free.</p>
          </div>
          <Button variant="destructive" onClick={() => setOpen(true)}>Cancel subscription</Button>
        </div>
        <div className="rounded-lg border p-3">
          <p className="font-medium">Delete organisation</p>
          <p className="text-muted-foreground">
            Self-service organisation deletion is not available yet. Export your data from the Data export tab (or{" "}
            <Link href="/billing" className="text-primary hover:underline">cancel your plan</Link>) and contact support to have the workspace removed.
          </p>
        </div>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel subscription?"
        description="Billing stops at the end of the current period. You keep access until then."
        confirmLabel="Cancel subscription"
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </Card>
  );
}
