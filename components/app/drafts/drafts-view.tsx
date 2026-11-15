"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/fetcher";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

interface Facts {
  org?: { name?: string; business_description?: string };
  goal?: string;
  contact?: Record<string, string | undefined>;
  approved_offers?: string[];
}
interface Draft {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  created_at: string;
  origin: string | null;
  facts: Facts | null;
  warnings: string[];
  contact: { id: string; full_name: string; company: string | null; phone: string; email: string | null };
}
interface DraftsResponse {
  pending_count: number;
  items: Draft[];
}

const KEY = ["ai-drafts", "pending"] as const;
const ORIGIN: Record<string, string> = { automation: "Automation", workflow: "Workflow", inbox: "Inbox AI reply", campaign: "Campaign", voice_script: "Voice script" };

function DraftCard({ draft }: { draft: Draft }) {
  const qc = useQueryClient();
  const [body, setBody] = React.useState(draft.body);
  const [subject, setSubject] = React.useState(draft.subject ?? "");
  const [showFacts, setShowFacts] = React.useState(false);
  const [ack, setAck] = React.useState(false);
  const edited = body !== draft.body || (draft.subject ?? "") !== subject;
  const hasWarnings = draft.warnings.length > 0;

  const done = () => qc.invalidateQueries({ queryKey: ["ai-drafts"] });
  const approve = useMutation({
    mutationFn: () =>
      api(`/api/ai-drafts/${draft.id}/approve`, {
        method: "POST",
        json: { body, ...(draft.channel === "email" ? { subject } : {}), acknowledge_warnings: ack },
      }),
    onSuccess: () => {
      toast.success("Approved and sent");
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: () => api(`/api/ai-drafts/${draft.id}/reject`, { method: "POST", json: {} }),
    onSuccess: () => {
      toast.success("Draft rejected");
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{draft.contact.full_name}{draft.contact.company ? ` · ${draft.contact.company}` : ""}</p>
            <p className="text-xs text-muted-foreground">
              {draft.channel === "email" ? draft.contact.email ?? "no email" : draft.contact.phone} · {new Date(draft.created_at).toLocaleString()}
            </p>
          </div>
          <div className="flex gap-2">
            <Badge variant="secondary" className="capitalize">{draft.channel}</Badge>
            {draft.origin ? <Badge variant="outline">{ORIGIN[draft.origin] ?? draft.origin}</Badge> : null}
          </div>
        </div>

        {hasWarnings ? (
          <div role="alert" className="space-y-1 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
            <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Check before sending</p>
            <ul className="list-disc pl-6">
              {draft.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        ) : null}

        {draft.channel === "email" ? (
          <div className="space-y-1.5">
            <Label htmlFor={`s-${draft.id}`}>Subject</Label>
            <Input id={`s-${draft.id}`} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={`b-${draft.id}`}>Message {edited ? <span className="text-xs text-muted-foreground">(edited)</span> : null}</Label>
          <Textarea id={`b-${draft.id}`} rows={5} value={body} maxLength={4096} onChange={(e) => setBody(e.target.value)} />
        </div>

        <div>
          <button type="button" onClick={() => setShowFacts((v) => !v)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            {showFacts ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} Facts the AI was allowed to use
          </button>
          {showFacts ? (
            <div className="mt-2 space-y-1 rounded-md bg-muted p-3 text-xs">
              {draft.facts ? (
                <>
                  <p><span className="font-medium">Goal:</span> {draft.facts.goal}</p>
                  <p><span className="font-medium">Business:</span> {draft.facts.org?.name}{draft.facts.org?.business_description ? ` - ${draft.facts.org.business_description}` : ""}</p>
                  <p><span className="font-medium">Approved offers:</span> {draft.facts.approved_offers?.length ? draft.facts.approved_offers.join("; ") : "none (the AI may not mention any offer or price)"}</p>
                  <p><span className="font-medium">Contact:</span> {Object.entries(draft.facts.contact ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ")}</p>
                </>
              ) : (
                <p>No grounding facts were stored for this draft.</p>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          {hasWarnings ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} /> I have reviewed the warnings
            </label>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => reject.mutate()}>
              {reject.isPending ? <Loader2 className="animate-spin" /> : <X />} Reject
            </Button>
            <Button disabled={busy || !body.trim() || (hasWarnings && !ack)} onClick={() => approve.mutate()}>
              {approve.isPending ? <Loader2 className="animate-spin" /> : <Check />} {edited ? "Approve edited & send" : "Approve & send"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DraftsView() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api<DraftsResponse>("/api/ai-drafts?status=pending"), refetchInterval: 30_000 });
  return (
    <div>
      <PageHeader
        title="Approvals"
        description="AI-written messages wait here until a person approves them. Edit anything before sending; nothing is sent automatically."
      />
      {q.isLoading ? (
        <div className="space-y-4"><Skeleton className="h-56 w-full" /><Skeleton className="h-56 w-full" /></div>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : q.data && q.data.items.length > 0 ? (
        <div className="space-y-4">{q.data.items.map((d) => <DraftCard key={d.id} draft={d} />)}</div>
      ) : (
        <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">No drafts are waiting for approval.</CardContent></Card>
      )}
    </div>
  );
}
