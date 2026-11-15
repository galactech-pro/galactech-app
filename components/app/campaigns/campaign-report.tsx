"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Pause, Play } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { DataTable, type Column } from "@/components/app/data-table";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/fetcher";
import { errMsg, fmtDate } from "@/components/app/contacts/types";
import { ChannelIcon, channelLabel } from "./channel-icon";
import { STATUS_BADGE, type CampaignStatus, type Channel } from "./types";

interface LogRow {
  id: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  replied_at: string | null;
  created_at: string;
  contact: { id: string; full_name: string; phone: string; email: string | null };
}
interface Stats {
  campaign: { id: string; name: string; channel: Channel; status: CampaignStatus; scheduled_at: string | null; sent_at: string | null };
  audience_total: number;
  totals: {
    sent: number;
    delivered: number;
    read: number;
    opened: number;
    clicked: number;
    replied: number;
    failed: number;
    converted: number;
    deals: number;
    revenue_inr: string;
  };
  log: { items: LogRow[]; total: number; page: number; page_size: number };
}

const ANY = "__any";
const LOG_STATUS_VARIANT: Record<string, "muted" | "default" | "success" | "danger" | "secondary"> = {
  queued: "muted",
  sent: "secondary",
  delivered: "default",
  read: "success",
  failed: "danger",
};

export function CampaignReport({ id }: { id: string }) {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [status, setStatus] = React.useState(ANY);
  const [page, setPage] = React.useState(1);

  const params = new URLSearchParams({ page: String(page), page_size: "25" });
  if (status !== ANY) params.set("status", status);

  const q = useQuery({
    queryKey: ["campaign-stats", id, params.toString()],
    queryFn: () => api<Stats>(`/api/campaigns/${id}/stats?${params}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.campaign.status === "sending" ? 3000 : false),
  });

  const act = useMutation({
    mutationFn: (action: "pause" | "resume") => api(`/api/campaigns/${id}/${action}`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["campaign-stats", id] }),
    onError: (e) => {
      if (!handleError(e)) toast.error(errMsg(e));
    },
  });

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="mb-3 text-sm text-destructive">{errMsg(q.error)}</p>
        <Button asChild variant="outline">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
      </div>
    );
  }

  const { campaign: c, totals: t, audience_total: total, log } = q.data;
  const pct = total > 0 ? Math.min(100, ((t.sent + t.failed) / total) * 100) : 0;
  const funnel: [string, number][] = [
    ["Sent", t.sent],
    ["Delivered", t.delivered],
    ["Read", t.read],
    ["Opened", t.opened],
    ["Clicked", t.clicked],
    ["Replied", t.replied],
    ["Converted", t.converted],
  ];
  const max = Math.max(1, ...funnel.map(([, v]) => v));
  const pages = Math.max(1, Math.ceil(log.total / log.page_size));

  const columns: Column<LogRow>[] = [
    {
      key: "contact",
      header: "Contact",
      cell: (r) => (
        <Link href={`/contacts/${r.contact.id}`} className="hover:underline">
          <div className="font-medium">{r.contact.full_name}</div>
          <div className="text-xs text-muted-foreground">{c.channel === "email" ? r.contact.email : r.contact.phone}</div>
        </Link>
      ),
    },
    { key: "status", header: "Status", cell: (r) => <Badge variant={LOG_STATUS_VARIANT[r.status] ?? "muted"} className="capitalize">{r.status}</Badge> },
    { key: "sent", header: "Sent", cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{fmtDate(r.sent_at ?? r.created_at, true)}</span> },
    {
      key: "eng",
      header: "Engagement",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.opened_at && <Badge variant="outline">opened</Badge>}
          {r.clicked_at && <Badge variant="outline">clicked</Badge>}
          {r.replied_at && <Badge variant="outline">replied</Badge>}
        </div>
      ),
    },
    { key: "err", header: "Error", cell: (r) => <span className="text-xs text-destructive">{r.error ?? ""}</span>, className: "hidden md:table-cell", headClassName: "hidden md:table-cell" },
  ];

  return (
    <div>
      <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Campaigns
      </Link>
      <PageHeader
        title={c.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <ChannelIcon channel={c.channel} className="h-4 w-4" /> {channelLabel(c.channel)}
            <Badge variant={STATUS_BADGE[c.status]} className="capitalize">
              {c.status}
            </Badge>
            {c.scheduled_at && c.status === "scheduled" && <span>Scheduled {fmtDate(c.scheduled_at, true)}</span>}
            {c.sent_at && <span>Sent {fmtDate(c.sent_at, true)}</span>}
          </span>
        }
        actions={
          <>
            {(c.status === "sending" || c.status === "scheduled") && (
              <Button variant="outline" onClick={() => act.mutate("pause")} disabled={act.isPending}>
                <Pause /> Pause
              </Button>
            )}
            {c.status === "paused" && (
              <Button variant="outline" onClick={() => act.mutate("resume")} disabled={act.isPending}>
                <Play /> Resume
              </Button>
            )}
          </>
        }
      />

      {c.status === "sending" && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="mb-2 flex justify-between text-sm">
              <span>Sending...</span>
              <span className="text-muted-foreground">
                {t.sent + t.failed} / {total}
              </span>
            </div>
            <Progress value={pct} />
          </CardContent>
        </Card>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Funnel</h2>
              <span className="text-xs text-muted-foreground">Audience {total.toLocaleString("en-IN")}</span>
            </div>
            {funnel.map(([label, v]) => (
              <div key={label} className="grid grid-cols-[80px_1fr_90px] items-center gap-3 text-sm">
                <span className="text-muted-foreground">{label}</span>
                <div className="h-5 overflow-hidden rounded bg-muted">
                  <div className="h-full rounded bg-primary/80" style={{ width: `${(v / max) * 100}%` }} />
                </div>
                <span className="text-right tabular-nums">
                  {v.toLocaleString("en-IN")}
                  {t.sent > 0 && label !== "Sent" ? <span className="text-xs text-muted-foreground"> ({Math.round((v / t.sent) * 100)}%)</span> : null}
                </span>
              </div>
            ))}
            {t.failed > 0 && <p className="text-xs text-destructive">{t.failed} failed</p>}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex h-full flex-col justify-center p-5">
            <div className="text-sm text-muted-foreground">Revenue attributed</div>
            <div className="text-3xl font-semibold">Rs {Number(t.revenue_inr).toLocaleString("en-IN")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t.converted} won of {t.deals} deals
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Message log</h2>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-40" aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All statuses</SelectItem>
            {["queued", "sent", "delivered", "read", "failed"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DataTable columns={columns} rows={log.items} rowKey={(r) => r.id} empty="No messages sent yet." />
      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
