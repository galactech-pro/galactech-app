"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { ArrowLeft, CheckCircle2, Circle, FileText, Handshake, MessageCircle, Pencil, Phone, PhoneCall, Plus, Sparkles, Star, X } from "lucide-react";
import { ScoreBadge } from "@/components/app/score-badge";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FetchError, api } from "@/lib/fetcher";
import { CONTACT_STATUSES, STATUS_VARIANT, errMsg, fmtDate, timeAgo, type Contact, type TeamMember } from "./types";

interface TimelineItem {
  type: "message" | "ai_call" | "note" | "task" | "deal" | "score";
  at: string;
  data: Record<string, unknown>;
}
interface ScorePoint {
  id: string;
  score: number;
  reason: string | null;
  created_at: string;
}
interface Task {
  id: string;
  title: string;
  due_at: string | null;
  done: boolean;
}
interface Deal {
  id: string;
  title: string;
  value_inr: string;
  stage: string;
}
interface Detail {
  contact: Contact;
  timeline: TimelineItem[];
  score_history: ScorePoint[];
  tasks: Task[];
  deals: Deal[];
}

const NONE = "__none";
const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function ContactDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const key = ["contact", id];
  const q = useQuery({ queryKey: key, queryFn: () => api<Detail>(`/api/contacts/${id}`) });
  const team = useQuery({ queryKey: ["team"], queryFn: () => api<{ members: TeamMember[] }>("/api/team"), staleTime: 300_000 });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["contacts"] });
  };
  const onErr = (e: unknown) => {
    if (!handleError(e)) toast.error(errMsg(e));
  };

  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState({ full_name: "", phone: "", email: "", company: "", job_title: "", status: "new", assigned_to: NONE });
  const [note, setNote] = React.useState("");
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskDue, setTaskDue] = React.useState("");
  const [tag, setTag] = React.useState("");
  const [waOpen, setWaOpen] = React.useState(false);
  const [waText, setWaText] = React.useState("");
  const [callOpen, setCallOpen] = React.useState(false);

  const c = q.data?.contact;
  React.useEffect(() => {
    if (c && !editing)
      setForm({
        full_name: c.full_name,
        phone: c.phone,
        email: c.email ?? "",
        company: c.company ?? "",
        job_title: c.job_title ?? "",
        status: c.status,
        assigned_to: c.assigned_to ?? NONE,
      });
  }, [c, editing]);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/api/contacts/${id}`, { method: "PATCH", json: body }),
    onSuccess: () => {
      toast.success("Saved");
      setEditing(false);
      setTag("");
      refresh();
    },
    onError: onErr,
  });
  const addNote = useMutation({
    mutationFn: () => api(`/api/contacts/${id}/notes`, { method: "POST", json: { body: note } }),
    onSuccess: () => {
      setNote("");
      refresh();
    },
    onError: onErr,
  });
  const addTask = useMutation({
    mutationFn: () =>
      api(`/api/contacts/${id}/tasks`, { method: "POST", json: { title: taskTitle, due_at: taskDue ? new Date(taskDue).toISOString() : null } }),
    onSuccess: () => {
      setTaskTitle("");
      setTaskDue("");
      refresh();
    },
    onError: onErr,
  });
  const toggleTask = useMutation({
    mutationFn: (t: Task) => api(`/api/contacts/${id}/tasks`, { method: "PATCH", json: { task_id: t.id, done: !t.done } }),
    onSuccess: refresh,
    onError: onErr,
  });
  const [dealOpen, setDealOpen] = React.useState(false);
  const [dealTitle, setDealTitle] = React.useState("");
  const [dealValue, setDealValue] = React.useState("");
  const addDeal = useMutation({
    mutationFn: () => api("/api/deals", { method: "POST", json: { contact_id: id, title: dealTitle, value_inr: Number(dealValue) || 0 } }),
    onSuccess: () => {
      setDealTitle("");
      setDealValue("");
      setDealOpen(false);
      toast.success("Deal created");
      refresh();
    },
    onError: onErr,
  });
  const moveDeal = useMutation({
    mutationFn: (v: { id: string; stage: string }) => api(`/api/deals/${v.id}`, { method: "PATCH", json: { stage: v.stage } }),
    onSuccess: refresh,
    onError: onErr,
  });
  const rescore = useMutation({
    mutationFn: () => api("/api/contacts/score", { method: "POST", json: { contact_id: id } }),
    onSuccess: () => {
      toast.success("Lead re-scored");
      refresh();
    },
    onError: onErr,
  });
  const sendWa = useMutation({
    mutationFn: () => api("/api/inbox/reply", { method: "POST", json: { contactId: id, text: waText } }),
    onSuccess: () => {
      toast.success("WhatsApp message sent");
      setWaText("");
      setWaOpen(false);
      refresh();
    },
    onError: (e) => {
      if (e instanceof FetchError && e.code === "SESSION_WINDOW_EXPIRED") {
        toast.error("24-hour window closed. Open the conversation in Inbox to send a template.");
        return;
      }
      onErr(e);
    },
  });
  const startCall = useMutation({
    mutationFn: () => api("/api/voice/call", { method: "POST", json: { contactId: id } }),
    onSuccess: () => {
      toast.success("AI call started");
      setCallOpen(false);
      refresh();
    },
    onError: onErr,
  });

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (q.isError || !c || !q.data) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="mb-3 text-sm text-destructive">{errMsg(q.error)}</p>
        <Button asChild variant="outline">
          <Link href="/contacts">Back to contacts</Link>
        </Button>
      </div>
    );
  }
  const d = q.data;
  const chart = d.score_history.map((p) => ({ date: fmtDate(p.created_at), score: p.score }));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="space-y-6">
      <Link href="/contacts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Contacts
      </Link>

      <Card>
        <CardContent className="space-y-4 p-5">
          {editing ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Input value={form.full_name} onChange={set("full_name")} placeholder="Full name" aria-label="Full name" />
              <Input value={form.phone} onChange={set("phone")} placeholder="Phone" aria-label="Phone" />
              <Input value={form.email} onChange={set("email")} placeholder="Email" aria-label="Email" />
              <Input value={form.company} onChange={set("company")} placeholder="Company" aria-label="Company" />
              <Input value={form.job_title} onChange={set("job_title")} placeholder="Job title" aria-label="Job title" />
              <Select value={form.status} onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}>
                <SelectTrigger aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTACT_STATUSES.map((st) => (
                    <SelectItem key={st} value={st} className="capitalize">
                      {st}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={form.assigned_to} onValueChange={(v) => setForm((p) => ({ ...p, assigned_to: v }))}>
                <SelectTrigger aria-label="Assigned to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {team.data?.members
                    .filter((m) => m.is_active)
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.full_name ?? m.email}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
                <Button
                  disabled={patch.isPending || !form.full_name.trim()}
                  onClick={() =>
                    patch.mutate({
                      full_name: form.full_name,
                      phone: form.phone,
                      email: form.email || null,
                      company: form.company || null,
                      job_title: form.job_title || null,
                      status: form.status,
                      assigned_to: form.assigned_to === NONE ? null : form.assigned_to,
                    })
                  }
                >
                  Save
                </Button>
                <Button variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{c.full_name}</h1>
                  <Badge variant={STATUS_VARIANT[c.status]} className="capitalize">
                    {c.status}
                  </Badge>
                  {c.dnc && <Badge variant="danger">DNC</Badge>}
                  {c.wa_opt_out && <Badge variant="warning">WA opt-out</Badge>}
                  {c.email_opt_out && <Badge variant="warning">Email opt-out</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">{[c.job_title, c.company].filter(Boolean).join(" at ") || "No company info"}</p>
                <p className="text-sm">
                  {c.phone}
                  {c.email ? <span className="text-muted-foreground"> | {c.email}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  Owner: {c.assignee?.full_name ?? c.assignee?.email ?? "Unassigned"} | Last contacted {timeAgo(c.last_contacted_at)} | Source: {c.source ?? "-"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ScoreBadge score={c.lead_score} reason={c.score_reason} className="h-8 min-w-10 text-sm" />
                <Button variant="outline" size="sm" onClick={() => rescore.mutate()} disabled={rescore.isPending}>
                  <Sparkles /> {rescore.isPending ? "Scoring..." : "Re-score"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            {c.tags.map((t) => (
              <Badge key={t} variant="outline" className="gap-1 font-normal">
                {t}
                <button aria-label={`Remove tag ${t}`} onClick={() => patch.mutate({ remove_tags: [t] })}>
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (tag.trim()) patch.mutate({ add_tags: [tag.trim()] });
              }}
            >
              <Input className="h-7 w-28 text-xs" placeholder="Add tag" value={tag} onChange={(e) => setTag(e.target.value)} />
              <Button type="submit" size="icon" variant="ghost" className="h-7 w-7" aria-label="Add tag">
                <Plus />
              </Button>
            </form>
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={() => setWaOpen(true)} disabled={c.wa_opt_out || c.dnc}>
                <MessageCircle /> WhatsApp
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCallOpen(true)} disabled={c.dnc}>
                <PhoneCall /> AI call
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {d.timeline.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ol className="space-y-4">
                  {d.timeline.map((t, i) => (
                    <TimelineRow key={`${t.type}-${i}`} item={t} />
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Score history</CardTitle>
            </CardHeader>
            <CardContent>
              {chart.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not scored yet.</p>
              ) : (
                <>
                  <div className="h-32">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chart}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="date" hide />
                        <YAxis domain={[0, 10]} width={24} tick={{ fontSize: 11 }} />
                        <RTooltip />
                        <Line type="monotone" dataKey="score" stroke="hsl(var(--primary))" strokeWidth={2} dot />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-3 max-h-40 space-y-2 overflow-auto text-xs">
                    {d.score_history
                      .slice()
                      .reverse()
                      .map((p) => (
                        <li key={p.id} className="flex gap-2">
                          <ScoreBadge score={p.score} />
                          <span className="text-muted-foreground">
                            {p.reason ?? "No reason"} <span className="opacity-70">({fmtDate(p.created_at)})</span>
                          </span>
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea rows={3} placeholder="Add a note..." value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                Add note
              </Button>
              <ul className="space-y-2 text-sm">
                {d.timeline
                  .filter((t) => t.type === "note")
                  .slice(0, 5)
                  .map((t, i) => (
                    <li key={i} className="rounded-md bg-muted/60 p-2">
                      <p className="whitespace-pre-wrap">{s(t.data.body)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {s((t.data.user as { full_name?: string } | undefined)?.full_name)} | {timeAgo(t.at)}
                      </p>
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tasks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (taskTitle.trim()) addTask.mutate();
                }}
              >
                <Input placeholder="New task" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
                <div className="flex gap-2">
                  <Input type="datetime-local" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} aria-label="Due" />
                  <Button type="submit" size="sm" disabled={!taskTitle.trim() || addTask.isPending}>
                    Add
                  </Button>
                </div>
              </form>
              {d.tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open tasks.</p>
              ) : (
                <ul className="space-y-2">
                  {d.tasks.map((t) => (
                    <li key={t.id} className="flex items-start gap-2 text-sm">
                      <button aria-label="Mark done" onClick={() => toggleTask.mutate(t)} className="mt-0.5 text-muted-foreground hover:text-primary">
                        {t.done ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                      </button>
                      <div>
                        <div>{t.title}</div>
                        {t.due_at && <div className="text-xs text-muted-foreground">Due {fmtDate(t.due_at, true)}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Deals</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setDealOpen((o) => !o)}><Plus /> Add deal</Button>
              </div>
            </CardHeader>
            <CardContent>
              {dealOpen ? (
                <form
                  className="mb-3 space-y-2 rounded-md border p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (dealTitle.trim()) addDeal.mutate();
                  }}
                >
                  <Input value={dealTitle} onChange={(e) => setDealTitle(e.target.value)} placeholder="Deal title" maxLength={200} aria-label="Deal title" autoFocus />
                  <Input value={dealValue} onChange={(e) => setDealValue(e.target.value.replace(/[^\d.]/g, ""))} placeholder="Value in rupees" inputMode="decimal" aria-label="Deal value" />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={!dealTitle.trim() || addDeal.isPending}>Create</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDealOpen(false)}>Cancel</Button>
                  </div>
                </form>
              ) : null}
              {d.deals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No deals yet.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {d.deals.map((dl) => (
                    <li key={dl.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{dl.title}</span>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        {"\u20B9"}{Number(dl.value_inr).toLocaleString("en-IN")}
                        <Select value={dl.stage} onValueChange={(v) => moveDeal.mutate({ id: dl.id, stage: v })}>
                          <SelectTrigger className="h-7 w-[110px] text-xs capitalize" aria-label={`Stage of ${dl.title}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {["lead", "qualified", "demo", "proposal", "won", "lost"].map((st) => <SelectItem key={st} value={st} className="capitalize">{st}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={waOpen} onOpenChange={setWaOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send WhatsApp to {c.full_name}</DialogTitle>
            <DialogDescription>Free-form messages only work within 24 hours of their last reply.</DialogDescription>
          </DialogHeader>
          <Textarea rows={5} value={waText} onChange={(e) => setWaText(e.target.value)} placeholder="Type your message" />
          <DialogFooter>
            <Button disabled={!waText.trim() || sendWa.isPending} onClick={() => sendWa.mutate()}>
              {sendWa.isPending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={callOpen} onOpenChange={setCallOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start AI call?</DialogTitle>
            <DialogDescription>The AI agent will call {c.phone} now using your organisation&apos;s voice settings. This uses AI call minutes.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCallOpen(false)}>
              Cancel
            </Button>
            <Button disabled={startCall.isPending} onClick={() => startCall.mutate()}>
              <Phone /> {startCall.isPending ? "Calling..." : "Start call"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const { type, data } = item;
  let icon = <FileText className="h-4 w-4" />;
  let title = "";
  let body: React.ReactNode = null;
  switch (type) {
    case "message":
      icon = <MessageCircle className="h-4 w-4" />;
      title = `${data.direction === "inbound" ? "Received" : "Sent"} ${s(data.channel)} message`;
      body = (
        <>
          <p className="whitespace-pre-wrap">{s(data.content)}</p>
          {data.direction === "outbound" && <span className="text-xs text-muted-foreground capitalize">{s(data.status)}</span>}
        </>
      );
      break;
    case "ai_call":
      icon = <PhoneCall className="h-4 w-4" />;
      title = `AI call${data.outcome ? ` - ${s(data.outcome).replace("_", " ")}` : ""}`;
      body = <p>{s(data.summary) || `Status: ${s(data.status)}${data.duration_seconds ? `, ${s(data.duration_seconds)}s` : ""}`}</p>;
      break;
    case "note":
      icon = <FileText className="h-4 w-4" />;
      title = "Note added";
      body = <p className="whitespace-pre-wrap">{s(data.body)}</p>;
      break;
    case "task":
      icon = <CheckCircle2 className="h-4 w-4" />;
      title = data.done ? "Task completed" : "Task created";
      body = <p>{s(data.title)}</p>;
      break;
    case "deal":
      icon = <Handshake className="h-4 w-4" />;
      title = `Deal (${s(data.stage)})`;
      body = (
        <p>
          {s(data.title)} - Rs {Number(s(data.value_inr)).toLocaleString("en-IN")}
        </p>
      );
      break;
    case "score":
      icon = <Star className="h-4 w-4" />;
      title = `Lead scored ${s(data.score)}/10`;
      body = <p className="text-muted-foreground">{s(data.reason)}</p>;
      break;
  }
  return (
    <li className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium capitalize">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.at)}</span>
        </div>
        {body}
      </div>
    </li>
  );
}
