"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, MoreHorizontal, Pause, Play, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/fetcher";
import { errMsg, fmtDate, type Paged } from "@/components/app/contacts/types";
import { ChannelIcon, channelLabel } from "./channel-icon";
import { STATUS_BADGE, type Campaign } from "./types";

const ANY = "__any";
const PAGE_SIZE = 12;

export function CampaignsList() {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [status, setStatus] = React.useState(ANY);
  const [channel, setChannel] = React.useState(ANY);
  const [page, setPage] = React.useState(1);

  const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
  if (status !== ANY) params.set("status", status);
  if (channel !== ANY) params.set("channel", channel);

  const q = useQuery({
    queryKey: ["campaigns", params.toString()],
    queryFn: () => api<Paged<Campaign>>(`/api/campaigns?${params}`),
    placeholderData: keepPreviousData,
    // keep running campaigns fresh
    refetchInterval: (query) => (query.state.data?.items.some((c) => c.status === "sending") ? 5000 : false),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "duplicate" | "pause" | "resume" | "delete" }) =>
      action === "delete" ? api(`/api/campaigns/${id}`, { method: "DELETE" }) : api(`/api/campaigns/${id}/${action}`, { method: "POST" }),
    onSuccess: (_d, v) => {
      toast.success(v.action === "delete" ? "Campaign deleted" : `Campaign ${v.action}${v.action.endsWith("e") ? "d" : "ed"}`);
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (e) => {
      if (!handleError(e)) toast.error(errMsg(e));
    },
  });

  const items = q.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Broadcast WhatsApp, email and voice campaigns to your contacts."
        actions={
          <Button asChild>
            <Link href="/campaigns/new">
              <Plus /> New campaign
            </Link>
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-40" aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All statuses</SelectItem>
            {["draft", "scheduled", "sending", "sent", "paused"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={channel} onValueChange={(v) => { setChannel(v); setPage(1); }}>
          <SelectTrigger className="w-40" aria-label="Channel filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All channels</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="voice">Voice</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="rounded-xl border border-destructive/30 p-6 text-center text-sm">
          <p className="mb-3 text-destructive">{errMsg(q.error)}</p>
          <Button variant="outline" size="sm" onClick={() => q.refetch()}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <p className="mb-4 text-sm text-muted-foreground">No campaigns yet. Create your first one to reach your contacts.</p>
          <Button asChild>
            <Link href="/campaigns/new">
              <Plus /> New campaign
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => {
            const st = c.stats ?? {};
            const total = st.total ?? 0;
            return (
              <Card key={c.id} className="transition-shadow hover:shadow-md">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/campaigns/${c.id}`} className="min-w-0 flex-1">
                      <div className="truncate font-medium hover:underline">{c.name}</div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <ChannelIcon channel={c.channel} className="h-3.5 w-3.5" />
                        {channelLabel(c.channel)}
                        <Badge variant={STATUS_BADGE[c.status]} className="capitalize">
                          {c.status}
                        </Badge>
                      </div>
                    </Link>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Campaign actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/campaigns/${c.id}`}>View report</Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => act.mutate({ id: c.id, action: "duplicate" })}>
                          <Copy className="mr-2 h-4 w-4" /> Duplicate
                        </DropdownMenuItem>
                        {(c.status === "sending" || c.status === "scheduled") && (
                          <DropdownMenuItem onClick={() => act.mutate({ id: c.id, action: "pause" })}>
                            <Pause className="mr-2 h-4 w-4" /> Pause
                          </DropdownMenuItem>
                        )}
                        {c.status === "paused" && (
                          <DropdownMenuItem onClick={() => act.mutate({ id: c.id, action: "resume" })}>
                            <Play className="mr-2 h-4 w-4" /> Resume
                          </DropdownMenuItem>
                        )}
                        {(c.status === "draft" || c.status === "scheduled") && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => {
                                if (confirm(`Delete "${c.name}"?`)) act.mutate({ id: c.id, action: "delete" });
                              }}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    {[
                      ["Audience", total],
                      ["Sent", st.sent ?? 0],
                      ["Replied", st.replied ?? 0],
                      ["Converted", st.converted ?? 0],
                    ].map(([label, val]) => (
                      <div key={label as string}>
                        <div className="text-lg font-semibold">{(val as number).toLocaleString("en-IN")}</div>
                        <div className="text-[11px] text-muted-foreground">{label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {c.status === "scheduled" && c.scheduled_at
                      ? `Scheduled for ${fmtDate(c.scheduled_at, true)}`
                      : c.sent_at
                        ? `Sent ${fmtDate(c.sent_at, true)}`
                        : `Created ${fmtDate(c.created_at)}`}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
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
      )}
    </div>
  );
}
