"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Download, Filter, MoreHorizontal, Plus, Search, Sparkles, Tag, Trash2, Upload, Megaphone, X } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { DataTable, type Column } from "@/components/app/data-table";
import { ScoreBadge } from "@/components/app/score-badge";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/fetcher";
import { AddContactSheet } from "./add-contact-sheet";
import { ImportDialog } from "./import-dialog";
import { CONTACT_STATUSES, STATUS_VARIANT, downloadBlob, errMsg, fmtDate, useDebounced, type Contact, type Paged, type TeamMember } from "./types";

const ANY = "__any";
const PAGE_SIZE = 25;

interface Filters {
  tags: string;
  score_min: string;
  score_max: string;
  status: string;
  opt_out: string;
  assigned_to: string;
}
const EMPTY_FILTERS: Filters = { tags: "", score_min: "", score_max: "", status: ANY, opt_out: ANY, assigned_to: ANY };

export function ContactsView() {
  const router = useRouter();
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();

  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const q = useDebounced(search);
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [tagOpen, setTagOpen] = React.useState(false);
  const [campOpen, setCampOpen] = React.useState(false);
  const [delOpen, setDelOpen] = React.useState(false);
  const [scoreProgress, setScoreProgress] = React.useState<{ done: number; total: number } | null>(null);

  const params = React.useMemo(() => {
    const p = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (q) p.set("q", q);
    const tags = filters.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length) p.set("tags", tags.join(","));
    if (filters.score_min) p.set("score_min", filters.score_min);
    if (filters.score_max) p.set("score_max", filters.score_max);
    if (filters.status !== ANY) p.set("status", filters.status);
    if (filters.opt_out !== ANY) p.set("opt_out", filters.opt_out);
    if (filters.assigned_to !== ANY) p.set("assigned_to", filters.assigned_to);
    return p.toString();
  }, [page, q, filters]);

  React.useEffect(() => setPage(1), [q, filters]);

  const list = useQuery({
    queryKey: ["contacts", params],
    queryFn: () => api<Paged<Contact>>(`/api/contacts?${params}`),
    placeholderData: keepPreviousData,
  });
  const team = useQuery({ queryKey: ["team"], queryFn: () => api<{ members: TeamMember[] }>("/api/team"), staleTime: 300_000 });

  const rows = list.data?.items;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allOnPage = !!rows?.length && rows.every((r) => selected.has(r.id));
  const activeFilters = Object.entries(filters).filter(([k, v]) => v !== "" && v !== ANY && k).length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allOnPage) rows?.forEach((r) => n.delete(r.id));
      else rows?.forEach((r) => n.add(r.id));
      return n;
    });

  const onErr = (e: unknown) => {
    if (!handleError(e)) toast.error(errMsg(e));
  };

  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ affected: number }>("/api/contacts/bulk", { method: "POST", json: { ...body, ids: [...selected].slice(0, 500) } }),
    onSuccess: (r, vars) => {
      toast.success(`${vars.action === "delete" ? "Deleted" : "Updated"} ${r.affected} contact(s)`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: onErr,
  });

  const exportCsv = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/contacts/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "export", ids: [...selected].slice(0, 500) }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? "Export failed");
      }
      downloadBlob(await res.blob(), "contacts.csv");
    },
    onError: onErr,
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/contacts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Contact deleted");
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: onErr,
  });

  const scoreAll = useMutation({
    mutationFn: async () => {
      let done = 0;
      let total = 0;
      setScoreProgress({ done: 0, total: 0 });
      for (let guard = 0; guard < 200; guard++) {
        const r = await api<{ scored: number; failed: number; remaining: number }>("/api/contacts/score", {
          method: "POST",
          json: { all_unscored: true },
        });
        done += r.scored;
        total = Math.max(total, done + r.remaining);
        setScoreProgress({ done, total });
        // stop when nothing remains, or no progress was made (all failed) to avoid looping forever
        if (r.remaining <= 0 || r.scored === 0) break;
      }
      return done;
    },
    onSuccess: (n) => {
      toast.success(n ? `Scored ${n} leads` : "No unscored leads");
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: onErr,
    onSettled: () => setTimeout(() => setScoreProgress(null), 2500),
  });

  const columns: Column<Contact>[] = [
    {
      key: "sel",
      header: <Checkbox checked={allOnPage} onCheckedChange={toggleAll} aria-label="Select all" />,
      cell: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={`Select ${r.full_name}`} />
        </div>
      ),
      className: "w-10",
      headClassName: "w-10",
    },
    {
      key: "name",
      header: "Name",
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.full_name}</div>
          {r.company ? <div className="truncate text-xs text-muted-foreground">{r.company}</div> : null}
        </div>
      ),
    },
    { key: "phone", header: "Phone", cell: (r) => <span className="whitespace-nowrap">{r.phone}</span> },
    { key: "email", header: "Email", cell: (r) => <span className="text-muted-foreground">{r.email ?? "-"}</span>, className: "hidden lg:table-cell", headClassName: "hidden lg:table-cell" },
    { key: "score", header: "Score", cell: (r) => <ScoreBadge score={r.lead_score} reason={r.score_reason} /> },
    {
      key: "tags",
      header: "Tags",
      cell: (r) => (
        <div className="flex max-w-[180px] flex-wrap gap-1">
          {r.tags.slice(0, 3).map((t) => (
            <Badge key={t} variant="outline" className="font-normal">
              {t}
            </Badge>
          ))}
          {r.tags.length > 3 ? <span className="text-xs text-muted-foreground">+{r.tags.length - 3}</span> : null}
        </div>
      ),
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
    },
    { key: "status", header: "Status", cell: (r) => <Badge variant={STATUS_VARIANT[r.status]} className="capitalize">{r.status}</Badge> },
    { key: "last", header: "Last contacted", cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{fmtDate(r.last_contacted_at)}</span>, className: "hidden xl:table-cell", headClassName: "hidden xl:table-cell" },
    {
      key: "actions",
      header: "",
      className: "w-10",
      cell: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Row actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/contacts/${r.id}`}>View profile</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/inbox?contact=${r.id}`}>Open conversation</Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => {
                  if (confirm(`Delete ${r.full_name}?`)) del.mutate(r.id);
                }}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Contacts"
        description={list.data ? `${total.toLocaleString("en-IN")} contacts` : "Your leads and customers"}
        actions={
          <>
            <Button variant="outline" onClick={() => scoreAll.mutate()} disabled={scoreAll.isPending}>
              <Sparkles /> Score all leads
            </Button>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload /> Import CSV
            </Button>
            <Button onClick={() => setAddOpen(true)}>
              <Plus /> Add contact
            </Button>
          </>
        }
      />

      {scoreProgress && (
        <div className="mb-4 rounded-lg border bg-card p-3 text-sm">
          <div className="mb-2 flex justify-between">
            <span>Scoring leads with AI...</span>
            <span className="text-muted-foreground">
              {scoreProgress.done}/{scoreProgress.total || "?"}
            </span>
          </div>
          <Progress value={scoreProgress.total ? (scoreProgress.done / scoreProgress.total) * 100 : 5} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search name, phone, email, company" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant={showFilters ? "secondary" : "outline"} onClick={() => setShowFilters((v) => !v)}>
          <Filter /> Filters{activeFilters ? ` (${activeFilters})` : ""}
        </Button>
        {activeFilters > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            <X /> Clear
          </Button>
        )}
      </div>

      {showFilters && (
        <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Tags (comma separated)</Label>
            <Input value={filters.tags} onChange={(e) => setFilters((f) => ({ ...f, tags: e.target.value }))} placeholder="vip, webinar" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Score min</Label>
              <Input type="number" min={1} max={10} value={filters.score_min} onChange={(e) => setFilters((f) => ({ ...f, score_min: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Score max</Label>
              <Input type="number" min={1} max={10} value={filters.score_max} onChange={(e) => setFilters((f) => ({ ...f, score_max: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {CONTACT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Opt-outs</Label>
            <Select value={filters.opt_out} onValueChange={(v) => setFilters((f) => ({ ...f, opt_out: v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Show all</SelectItem>
                <SelectItem value="any">Any opt-out</SelectItem>
                <SelectItem value="wa">WhatsApp opt-out</SelectItem>
                <SelectItem value="email">Email opt-out</SelectItem>
                <SelectItem value="dnc">Do not call</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Assigned to</Label>
            <Select value={filters.assigned_to} onValueChange={(v) => setFilters((f) => ({ ...f, assigned_to: v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Anyone</SelectItem>
                <SelectItem value="me">Me</SelectItem>
                {team.data?.members
                  .filter((m) => m.is_active)
                  .map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.full_name ?? m.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-accent/50 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => setTagOpen(true)}>
            <Tag /> Add tag
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCampOpen(true)}>
            <Megaphone /> Assign campaign
          </Button>
          <Button size="sm" variant="outline" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>
            <Download /> Export CSV
          </Button>
          <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDelOpen(true)}>
            <Trash2 /> Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {list.isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center text-sm">
          <p className="mb-3 text-destructive">{errMsg(list.error)}</p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          onRowClick={(r) => router.push(`/contacts/${r.id}`)}
          empty={
            q || activeFilters ? (
              "No contacts match your search or filters."
            ) : (
              <div className="space-y-3">
                <p>No contacts yet. Add one or import a CSV to get started.</p>
                <div className="flex justify-center gap-2">
                  <Button size="sm" onClick={() => setAddOpen(true)}>
                    <Plus /> Add contact
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                    <Upload /> Import CSV
                  </Button>
                </div>
              </div>
            )
          }
        />
      )}

      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft /> Prev
          </Button>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight />
          </Button>
        </div>
      </div>

      <AddContactSheet open={addOpen} onOpenChange={setAddOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <BulkTagDialog
        open={tagOpen}
        onOpenChange={setTagOpen}
        busy={bulk.isPending}
        onSubmit={(tag) => bulk.mutate({ action: "add_tag", tag }, { onSuccess: () => setTagOpen(false) })}
      />
      <AssignCampaignDialog
        open={campOpen}
        onOpenChange={setCampOpen}
        busy={bulk.isPending}
        onSubmit={(campaign_id) => bulk.mutate({ action: "assign_campaign", campaign_id }, { onSuccess: () => setCampOpen(false) })}
      />
      <Dialog open={delOpen} onOpenChange={setDelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selected.size} contact(s)?</DialogTitle>
            <DialogDescription>They will be removed from your lists. This can be undone only by re-adding them.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: "delete" }, { onSuccess: () => setDelOpen(false) })}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BulkTagDialog({ open, onOpenChange, onSubmit, busy }: { open: boolean; onOpenChange: (o: boolean) => void; onSubmit: (tag: string) => void; busy: boolean }) {
  const [tag, setTag] = React.useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add tag to selected contacts</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (tag.trim()) onSubmit(tag.trim());
          }}
        >
          <Input autoFocus value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag name" />
          <DialogFooter>
            <Button type="submit" disabled={!tag.trim() || busy}>
              Add tag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface CampaignLite {
  id: string;
  name: string;
  status: string;
  channel: string;
}

function AssignCampaignDialog({ open, onOpenChange, onSubmit, busy }: { open: boolean; onOpenChange: (o: boolean) => void; onSubmit: (id: string) => void; busy: boolean }) {
  const [id, setId] = React.useState("");
  const camps = useQuery({
    queryKey: ["campaigns", "assignable"],
    queryFn: () => api<Paged<CampaignLite>>("/api/campaigns?page_size=100"),
    enabled: open,
  });
  const eligible = camps.data?.items.filter((c) => c.status === "draft" || c.status === "scheduled") ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign to campaign</DialogTitle>
          <DialogDescription>Selected contacts are added to a draft or scheduled campaign&apos;s audience.</DialogDescription>
        </DialogHeader>
        {camps.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading campaigns...</p>
        ) : eligible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No draft or scheduled campaigns. Create one first.</p>
        ) : (
          <Select value={id} onValueChange={setId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose campaign" />
            </SelectTrigger>
            <SelectContent>
              {eligible.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} ({c.channel})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <DialogFooter>
          <Button disabled={!id || busy} onClick={() => onSubmit(id)}>
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
