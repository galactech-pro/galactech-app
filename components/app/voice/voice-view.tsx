"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { FileText, Play, Plus, Pause } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { DataTable, type Column } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/fetcher";
import { OutcomeBadge } from "./outcome-badge";
import { TranscriptDialog } from "./transcript-dialog";
import { fmtDuration, type VoiceCall, type VoiceList } from "./types";

const inr = (v: string | number) => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

export function VoiceView() {
  const [outcome, setOutcome] = React.useState("all");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState<{ id: string; audio: HTMLAudioElement } | null>(null);

  const params = new URLSearchParams({ page: String(page), page_size: "20" });
  if (outcome !== "all") params.set("outcome", outcome);
  if (from) params.set("from", from);
  if (to) params.set("to", `${to}T23:59:59`);

  const q = useQuery({ queryKey: ["voice-calls", outcome, from, to, page], queryFn: () => api<VoiceList>(`/api/voice/calls?${params}`) });

  React.useEffect(() => () => playing?.audio.pause(), [playing]);
  const togglePlay = (c: VoiceCall) => {
    if (!c.recording_url) return;
    if (playing?.id === c.id) {
      playing.audio.pause();
      setPlaying(null);
      return;
    }
    playing?.audio.pause();
    const audio = new Audio(c.recording_url);
    audio.onended = () => setPlaying(null);
    void audio.play();
    setPlaying({ id: c.id, audio });
  };

  const s = q.data?.stats;
  const columns: Column<VoiceCall>[] = [
    {
      key: "contact",
      header: "Contact",
      cell: (c) => (
        <div>
          <p className="font-medium">{c.contact.full_name}</p>
          <p className="text-xs text-muted-foreground">{c.contact.phone}</p>
        </div>
      ),
    },
    { key: "date", header: "Date", cell: (c) => <span className="whitespace-nowrap text-xs">{new Date(c.scheduled_at ?? c.created_at).toLocaleString()}</span> },
    { key: "dur", header: "Duration", cell: (c) => fmtDuration(c.duration_seconds) },
    { key: "outcome", header: "Outcome", cell: (c) => <OutcomeBadge outcome={c.outcome} status={c.scheduled_at && c.status === "initiated" ? "scheduled" : c.status} /> },
    {
      key: "preview",
      header: "Transcript",
      className: "hidden max-w-[260px] truncate text-xs text-muted-foreground md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (c) => (c.transcript ? c.transcript.slice(0, 100) + (c.transcript.length > 100 ? "…" : "") : "-"),
    },
    {
      key: "actions",
      header: "",
      cell: (c) => (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" title="View transcript" aria-label="View transcript" onClick={() => setOpen(c.id)}>
            <FileText className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" title="Play recording" aria-label="Play recording" disabled={!c.recording_url} onClick={() => togglePlay(c)}>
            {playing?.id === c.id ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
        </div>
      ),
    },
  ];

  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.page_size)) : 1;

  return (
    <div>
      <PageHeader
        title="AI Voice Calls"
        description="Calls placed by your AI voice agent."
        actions={
          <Button asChild>
            <Link href="/voice/new">
              <Plus className="mr-1 h-4 w-4" /> New AI Call
            </Link>
          </Button>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Total calls" value={s ? s.total_calls.toLocaleString("en-IN") : "-"} />
        <Stat label="Answer rate" value={s ? `${s.answer_rate}%` : "-"} />
        <Stat label="Avg duration" value={s ? fmtDuration(s.avg_duration_seconds) : "-"} />
        <Stat label="Calls this month" value={s ? `${s.calls_this_month}${s.calls_limit != null ? ` / ${s.calls_limit}` : ""}` : "-"} />
        <Stat label="Cost" value={s ? inr(s.cost_total_inr) : "-"} sub={s ? `${inr(s.cost_this_month_inr)} this month` : undefined} />
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select value={outcome} onValueChange={(v) => { setOutcome(v); setPage(1); }}>
          <SelectTrigger className="w-44" aria-label="Outcome"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All outcomes</SelectItem>
            <SelectItem value="interested">Interested</SelectItem>
            <SelectItem value="callback">Callback</SelectItem>
            <SelectItem value="not_interested">Not interested</SelectItem>
            <SelectItem value="no_answer">No answer</SelectItem>
            <SelectItem value="voicemail">Voicemail</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="From date" />
        <Input type="date" className="w-40" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="To date" />
        {outcome !== "all" || from || to ? (
          <Button variant="ghost" size="sm" onClick={() => { setOutcome("all"); setFrom(""); setTo(""); }}>Clear</Button>
        ) : null}
      </div>

      {q.isError ? (
        <div className="rounded-lg border p-6 text-center text-sm">
          <p className="text-destructive">{(q.error as Error).message}</p>
          <Button className="mt-3" variant="outline" onClick={() => q.refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={q.data?.items}
            rowKey={(c) => c.id}
            loading={q.isLoading}
            empty={<>No calls yet. <Link href="/voice/new" className="text-primary underline">Place your first AI call</Link>.</>}
          />
          {q.data && q.data.total > q.data.page_size ? (
            <div className="mt-3 flex items-center justify-end gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="text-muted-foreground">Page {page} of {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          ) : null}
        </>
      )}
      <TranscriptDialog callId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
