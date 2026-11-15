"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { ConfirmDialog } from "@/components/app/settings/confirm-dialog";
import { ContactPicker, type PickedContact } from "./contact-picker";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

const STAGES = ["lead", "qualified", "demo", "proposal", "won", "lost"] as const;
type Stage = (typeof STAGES)[number];
const STAGE_LABEL: Record<Stage, string> = { lead: "Lead", qualified: "Qualified", demo: "Demo", proposal: "Proposal", won: "Won", lost: "Lost" };

interface Deal {
  id: string;
  title: string;
  value_inr: string;
  stage: Stage;
  probability: number;
  notes: string | null;
  created_at: string;
  contact: { id: string; full_name: string; company: string | null };
  assignee: { id: string; full_name: string | null; email: string } | null;
}
interface Member { id: string; full_name: string | null; email: string; is_active: boolean }

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

export function DealsView() {
  const qc = useQueryClient();
  const [owner, setOwner] = React.useState<"all" | "me">("all");
  const [search, setSearch] = React.useState("");
  const deals = useQuery({
    queryKey: ["deals", owner],
    queryFn: () => api<Deal[]>(`/api/deals${owner === "me" ? "?assigned_to=me" : ""}`),
  });
  const team = useQuery({ queryKey: ["team"], queryFn: () => api<{ members: Member[] }>("/api/team"), staleTime: 300_000 });

  const list = (deals.data ?? []).filter((d) => !search.trim() || d.title.toLowerCase().includes(search.toLowerCase()) || d.contact.full_name.toLowerCase().includes(search.toLowerCase()));
  const open = list.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue = open.reduce((n, d) => n + Number(d.value_inr), 0);
  const forecast = open.reduce((n, d) => n + (Number(d.value_inr) * d.probability) / 100, 0);
  const won = list.filter((d) => d.stage === "won");
  const wonValue = won.reduce((n, d) => n + Number(d.value_inr), 0);
  const closed = list.filter((d) => d.stage === "won" || d.stage === "lost").length;
  const winRate = closed ? Math.round((won.length / closed) * 100) : null;

  const move = useMutation({
    mutationFn: (v: { id: string; stage: Stage }) => api(`/api/deals/${v.id}`, { method: "PATCH", json: { stage: v.stage } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["deals", owner] });
      const prev = qc.getQueryData<Deal[]>(["deals", owner]);
      qc.setQueryData<Deal[]>(["deals", owner], (old) => old?.map((d) => (d.id === v.id ? { ...d, stage: v.stage } : d)));
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["deals", owner], ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["deals"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/deals/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deals"] });
      toast.success("Deal deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // new deal dialog
  const [dlg, setDlg] = React.useState(false);
  const [contact, setContact] = React.useState<PickedContact | null>(null);
  const [title, setTitle] = React.useState("");
  const [value, setValue] = React.useState("");
  const [stage, setStage] = React.useState<Stage>("lead");
  const [assignee, setAssignee] = React.useState("me");
  const [notes, setNotes] = React.useState("");
  const create = useMutation({
    mutationFn: () =>
      api("/api/deals", { method: "POST", json: { contact_id: contact!.id, title, value_inr: Number(value) || 0, stage, notes: notes || undefined, ...(assignee !== "me" ? { assigned_to: assignee } : {}) } }),
    onSuccess: () => {
      toast.success("Deal created");
      setDlg(false);
      setContact(null); setTitle(""); setValue(""); setStage("lead"); setNotes(""); setAssignee("me");
      void qc.invalidateQueries({ queryKey: ["deals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<Stage | null>(null);
  const [del, setDel] = React.useState<Deal | null>(null);

  return (
    <div>
      <PageHeader
        title="Deals"
        description="Your sales pipeline. Drag a deal to the next stage, or use the stage menu on the card."
        actions={<Button onClick={() => setDlg(true)}><Plus /> New deal</Button>}
      />

      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4">
        {[
          { l: "Open pipeline", v: inr(openValue), s: `${open.length} open deals` },
          { l: "Weighted forecast", v: inr(forecast), s: "value x win chance" },
          { l: "Won", v: inr(wonValue), s: `${won.length} deals` },
          { l: "Win rate", v: winRate === null ? "-" : `${winRate}%`, s: closed ? `${closed} closed` : "no closed deals yet" },
        ].map((x) => (
          <div key={x.l} className="bg-card p-4">
            <p className="text-xs text-muted-foreground">{x.l}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{x.v}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{x.s}</p>
          </div>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search deals or contacts" className="max-w-xs" aria-label="Search deals" />
        <div className="inline-flex rounded-md border p-0.5 text-sm" role="group" aria-label="Owner">
          {(["all", "me"] as const).map((o) => (
            <button key={o} type="button" onClick={() => setOwner(o)} className={cn("rounded-sm px-3 py-1", owner === o ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {o === "all" ? "Everyone" : "Mine"}
            </button>
          ))}
        </div>
      </div>

      {deals.isError ? (
        <div className="rounded-lg border border-destructive/30 p-6 text-sm">
          <p className="text-destructive">{(deals.error as Error).message}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => deals.refetch()}>Retry</Button>
        </div>
      ) : deals.isLoading ? (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">{STAGES.map((s) => <Skeleton key={s} className="h-64 w-full" />)}</div>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
          <div className="grid min-w-[1080px] grid-cols-6 gap-3">
            {STAGES.map((st) => {
              const col = list.filter((d) => d.stage === st);
              const total = col.reduce((n, d) => n + Number(d.value_inr), 0);
              return (
                <section
                  key={st}
                  aria-label={`${STAGE_LABEL[st]} deals`}
                  onDragOver={(e) => { e.preventDefault(); setOverStage(st); }}
                  onDragLeave={() => setOverStage((o) => (o === st ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOverStage(null);
                    const d = list.find((x) => x.id === dragId);
                    setDragId(null);
                    if (d && d.stage !== st) move.mutate({ id: d.id, stage: st });
                  }}
                  className={cn("flex min-h-[260px] flex-col rounded-lg border bg-card/50 p-2 transition-colors", overStage === st && "border-primary/60 bg-secondary/40")}
                >
                  <header className="mb-2 flex items-baseline justify-between px-1.5 pt-1">
                    <h2 className="text-sm font-semibold">{STAGE_LABEL[st]} <span className="font-normal text-muted-foreground">{col.length}</span></h2>
                    <span className="text-xs text-muted-foreground">{inr(total)}</span>
                  </header>
                  <div className="flex flex-1 flex-col gap-2">
                    {col.map((d) => (
                      <article
                        key={d.id}
                        draggable
                        onDragStart={() => setDragId(d.id)}
                        onDragEnd={() => { setDragId(null); setOverStage(null); }}
                        className={cn("cursor-grab rounded-md border bg-card p-3 text-sm active:cursor-grabbing", dragId === d.id && "opacity-50")}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium leading-snug">{d.title}</p>
                          <button type="button" aria-label="Delete deal" className="text-muted-foreground hover:text-destructive" onClick={() => setDel(d)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                        <Link href={`/contacts/${d.contact.id}`} className="mt-0.5 block truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
                          {d.contact.full_name}{d.contact.company ? `, ${d.contact.company}` : ""}
                        </Link>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="font-semibold">{inr(Number(d.value_inr))}</span>
                          <span className="text-xs text-muted-foreground">{d.probability}%</span>
                        </div>
                        {d.assignee ? <p className="mt-1 truncate text-xs text-muted-foreground">{d.assignee.full_name || d.assignee.email}</p> : null}
                        <Select value={d.stage} onValueChange={(v) => move.mutate({ id: d.id, stage: v as Stage })}>
                          <SelectTrigger className="mt-2 h-7 text-xs" aria-label={`Move ${d.title}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{STAGES.map((s) => <SelectItem key={s} value={s}>{STAGE_LABEL[s]}</SelectItem>)}</SelectContent>
                        </Select>
                      </article>
                    ))}
                    {col.length === 0 ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">Drop a deal here</p> : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <Dialog open={dlg} onOpenChange={setDlg}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>A deal belongs to one contact.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Contact</Label><ContactPicker value={contact} onChange={setContact} /></div>
            <div className="space-y-1.5"><Label htmlFor="deal-title">Title</Label><Input id="deal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Annual plan for Acme" maxLength={200} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label htmlFor="deal-value">Value (₹)</Label><Input id="deal-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))} placeholder="50000" /></div>
              <div className="space-y-1.5">
                <Label>Stage</Label>
                <Select value={stage} onValueChange={(v) => setStage(v as Stage)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{STAGES.map((s) => <SelectItem key={s} value={s}>{STAGE_LABEL[s]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Owner</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">Me</SelectItem>
                  {(team.data?.members ?? []).filter((m) => m.is_active).map((m) => <SelectItem key={m.id} value={m.id}>{m.full_name || m.email}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="deal-notes">Notes</Label><Textarea id="deal-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={!contact || !title.trim() || create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" /> : null} Create deal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Delete this deal?"
        description={del ? `"${del.title}" will be removed from the pipeline. This cannot be undone.` : ""}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => del && remove.mutate(del.id, { onSettled: () => setDel(null) })}
      />
    </div>
  );
}
