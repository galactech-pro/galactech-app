"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { ContactPicker, type PickedContact } from "./contact-picker";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  due_at: string | null;
  done: boolean;
  contact: { id: string; full_name: string } | null;
  assignee: { id: string; full_name: string | null; email: string } | null;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function bucket(t: Task): "overdue" | "today" | "upcoming" | "nodate" {
  if (!t.due_at) return "nodate";
  const day = startOfDay(new Date(t.due_at));
  const today = startOfDay(new Date());
  return day < today ? "overdue" : day === today ? "today" : "upcoming";
}
const LABEL = { overdue: "Overdue", today: "Today", upcoming: "Upcoming", nodate: "No due date" } as const;

export function TasksView() {
  const qc = useQueryClient();
  const [scope, setScope] = React.useState<"mine" | "all">("mine");
  const [status, setStatus] = React.useState<"open" | "done">("open");
  const q = useQuery({ queryKey: ["tasks", scope, status], queryFn: () => api<Task[]>(`/api/tasks?scope=${scope}&status=${status}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["tasks"] });

  const toggle = useMutation({
    mutationFn: (t: Task) => api(`/api/tasks/${t.id}`, { method: "PATCH", json: { done: !t.done } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/tasks/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const [dlg, setDlg] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [due, setDue] = React.useState("");
  const [contact, setContact] = React.useState<PickedContact | null>(null);
  const create = useMutation({
    mutationFn: () => api("/api/tasks", { method: "POST", json: { title, due_at: due ? new Date(`${due}T09:00:00`).toISOString() : null, contact_id: contact?.id ?? null } }),
    onSuccess: () => {
      toast.success("Task added");
      setDlg(false); setTitle(""); setDue(""); setContact(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const groups = (["overdue", "today", "upcoming", "nodate"] as const).map((k) => ({ k, items: (q.data ?? []).filter((t) => bucket(t) === k) })).filter((g) => g.items.length);
  const overdueCount = (q.data ?? []).filter((t) => bucket(t) === "overdue").length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Tasks"
        description={status === "open" && overdueCount ? `${overdueCount} overdue` : "Follow-ups and to-dos across your contacts."}
        actions={<Button onClick={() => setDlg(true)}><Plus /> New task</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="inline-flex rounded-md border p-0.5 text-sm" role="group" aria-label="Whose tasks">
          {(["mine", "all"] as const).map((o) => (
            <button key={o} type="button" onClick={() => setScope(o)} className={cn("rounded-sm px-3 py-1", scope === o ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>{o === "mine" ? "Mine" : "Everyone"}</button>
          ))}
        </div>
        <div className="inline-flex rounded-md border p-0.5 text-sm" role="group" aria-label="Status">
          {(["open", "done"] as const).map((o) => (
            <button key={o} type="button" onClick={() => setStatus(o)} className={cn("rounded-sm px-3 py-1", status === o ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>{o === "open" ? "Open" : "Done"}</button>
          ))}
        </div>
      </div>

      {q.isError ? (
        <div className="rounded-lg border border-destructive/30 p-6 text-sm">
          <p className="text-destructive">{(q.error as Error).message}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
        </div>
      ) : q.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !q.data?.length ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="font-medium">{status === "open" ? "Nothing to do" : "No completed tasks yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">{status === "open" ? "Add a follow-up so no lead goes quiet." : "Tick a task off and it shows up here."}</p>
        </div>
      ) : status === "done" ? (
        <TaskList items={q.data} onToggle={(t) => toggle.mutate(t)} onDelete={(t) => remove.mutate(t.id)} />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.k}>
              <h2 className={cn("mb-2 text-sm font-semibold", g.k === "overdue" && "text-destructive")}>{LABEL[g.k]} <span className="font-normal text-muted-foreground">{g.items.length}</span></h2>
              <TaskList items={g.items} onToggle={(t) => toggle.mutate(t)} onDelete={(t) => remove.mutate(t.id)} />
            </section>
          ))}
        </div>
      )}

      <Dialog open={dlg} onOpenChange={setDlg}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>Assigned to you. Link a contact if it is about someone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="task-title">What needs doing</Label><Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call back about pricing" maxLength={300} autoFocus /></div>
            <div className="space-y-1.5"><Label htmlFor="task-due">Due date</Label><Input id="task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Contact (optional)</Label><ContactPicker value={contact} onChange={setContact} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={!title.trim() || create.isPending}>{create.isPending ? <Loader2 className="animate-spin" /> : null} Add task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskList({ items, onToggle, onDelete }: { items: Task[]; onToggle: (t: Task) => void; onDelete: (t: Task) => void }) {
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {items.map((t) => {
        const b = bucket(t);
        return (
          <li key={t.id} className="flex items-center gap-3 px-4 py-3">
            <Checkbox checked={t.done} onCheckedChange={() => onToggle(t)} aria-label={`Mark "${t.title}" ${t.done ? "not done" : "done"}`} />
            <div className="min-w-0 flex-1">
              <p className={cn("truncate text-sm", t.done && "text-muted-foreground line-through")}>{t.title}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {t.contact ? <Link href={`/contacts/${t.contact.id}`} className="hover:text-foreground hover:underline">{t.contact.full_name}</Link> : "No contact"}
                {t.assignee ? `, ${t.assignee.full_name || t.assignee.email}` : ""}
              </p>
            </div>
            {t.due_at ? <Badge variant={b === "overdue" && !t.done ? "danger" : "muted"}>{new Date(t.due_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</Badge> : null}
            <button type="button" aria-label="Delete task" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(t)}><Trash2 className="h-4 w-4" /></button>
          </li>
        );
      })}
    </ul>
  );
}
