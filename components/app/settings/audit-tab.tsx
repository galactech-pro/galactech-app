"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/app/data-table";
import { api } from "@/lib/fetcher";

interface AuditRow {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
  user: { email: string; full_name: string | null } | null;
}
interface AuditPage { items: AuditRow[]; total: number; page: number; page_size: number }
const PAGE_SIZE = 25;

export function AuditTab() {
  const [page, setPage] = React.useState(1);
  const [action, setAction] = React.useState("");
  const [entity, setEntity] = React.useState("");
  const [applied, setApplied] = React.useState({ action: "", entity: "" });

  const q = useQuery({
    queryKey: ["audit", page, applied],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (applied.action) p.set("action", applied.action);
      if (applied.entity) p.set("entity_type", applied.entity);
      return api<AuditPage>(`/api/settings/audit?${p}`);
    },
    placeholderData: (prev) => prev,
  });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.page_size)) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>Who changed what, most recent first.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied({ action: action.trim(), entity: entity.trim() });
          }}
        >
          <Input placeholder="Action contains… (e.g. team.)" value={action} onChange={(e) => setAction(e.target.value)} />
          <Input placeholder="Entity type (e.g. user)" value={entity} onChange={(e) => setEntity(e.target.value)} />
          <Button type="submit" variant="secondary">Filter</Button>
        </form>
        {q.isError ? (
          <div className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
            {(q.error as Error).message}{" "}
            <Button variant="link" className="h-auto p-0" onClick={() => q.refetch()}>Retry</Button>
          </div>
        ) : (
          <DataTable<AuditRow>
            loading={q.isLoading}
            rows={q.data?.items}
            rowKey={(r) => r.id}
            empty="No audit events match."
            columns={[
              { key: "when", header: "When", cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{new Date(r.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span> },
              { key: "who", header: "User", cell: (r) => r.user?.full_name ?? r.user?.email ?? "System", className: "hidden sm:table-cell", headClassName: "hidden sm:table-cell" },
              { key: "action", header: "Action", cell: (r) => <code className="text-xs">{r.action}</code> },
              { key: "entity", header: "Entity", cell: (r) => <span className="text-muted-foreground">{r.entity_type ?? "-"}{r.entity_id ? ` · ${r.entity_id.slice(0, 8)}` : ""}</span>, className: "hidden md:table-cell", headClassName: "hidden md:table-cell" },
            ]}
          />
        )}
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{q.data ? `${q.data.total.toLocaleString("en-IN")} events` : ""}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft /></Button>
            <span>Page {page} of {pages}</span>
            <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
