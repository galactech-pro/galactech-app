"use client";

import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/fetcher";
import { OutcomeBadge } from "./outcome-badge";
import { fmtDuration, type VoiceCall } from "./types";

const POST_ACTIONS: Record<string, string> = {
  interested: "Lead tagged hot, team alerted and follow-up queued.",
  callback: "Callback task created for your team.",
  not_interested: "Contact marked not interested; no further automated follow-ups.",
  no_answer: "Retry scheduled (up to 3 attempts).",
  voicemail: "Retry scheduled (up to 3 attempts).",
};

export function TranscriptDialog({ callId, onClose }: { callId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["voice-call", callId],
    queryFn: () => api<VoiceCall>(`/api/voice/calls/${callId}`),
    enabled: !!callId,
  });
  const c = q.data;
  return (
    <Dialog open={!!callId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{c?.contact.full_name ?? "Call transcript"}</DialogTitle>
          <DialogDescription>
            {c ? `${c.to_number} · ${new Date(c.created_at).toLocaleString()} · ${fmtDuration(c.duration_seconds)}` : "Loading call…"}
          </DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : q.isError ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : c ? (
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Outcome</span>
              <OutcomeBadge outcome={c.outcome} status={c.status} />
            </div>
            {c.recording_url ? <audio controls src={c.recording_url} className="w-full" /> : null}
            <section>
              <h3 className="mb-1 font-medium">AI summary</h3>
              <p className="text-muted-foreground">{c.summary ?? "No summary yet."}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium">Post-call actions</h3>
              <p className="text-muted-foreground">{c.outcome ? POST_ACTIONS[c.outcome] : "Pending call completion."}</p>
            </section>
            <section>
              <h3 className="mb-1 font-medium">Transcript</h3>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-sans text-xs leading-relaxed">
                {c.transcript ?? "No transcript available."}
              </pre>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
