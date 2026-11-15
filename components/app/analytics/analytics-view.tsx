"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Download, Sparkles } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { DataTable, type Column } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/fetcher";
import type { AnalyticsPayload } from "@/lib/analytics";

type Data = AnalyticsPayload & { insights: string | null };
type Range = "today" | "7d" | "30d" | "90d" | "custom";

// Categorical series colours (fixed order; text stays in ink tokens, colour only on marks).
const C1 = "#00C16A";
const C2 = "#CCCCCC";
const AXIS = "hsl(var(--muted-foreground))";

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const OVERVIEW: { key: keyof Data["overview"]["current"]; label: string; money?: boolean }[] = [
  { key: "leads", label: "New leads" },
  { key: "messages_sent", label: "Messages sent" },
  { key: "replies", label: "Replies" },
  { key: "deals_won", label: "Deals won" },
  { key: "revenue_inr", label: "Revenue", money: true },
  { key: "ai_calls", label: "AI calls" },
];

function Change({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-xs text-muted-foreground">no prior data</span>;
  const up = pct >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center text-xs font-medium ${up ? "text-green-700" : "text-red-700"}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {Math.abs(pct)}% <span className="ml-1 font-normal text-muted-foreground">vs previous</span>
    </span>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const tooltipStyle = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, color: "hsl(var(--foreground))" };

export function AnalyticsView() {
  const [range, setRange] = React.useState<Range>("30d");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [withInsights, setWithInsights] = React.useState(false);
  const [exporting, setExporting] = React.useState<string | null>(null);

  const customReady = range !== "custom" || (!!from && !!to && from <= to);
  const qs = new URLSearchParams({ range });
  if (range === "custom") {
    qs.set("from", from);
    qs.set("to", to);
  }
  const base = qs.toString();

  const q = useQuery({
    queryKey: ["analytics", base],
    queryFn: () => api<Data>(`/api/analytics?${base}`),
    enabled: customReady,
  });
  const ins = useQuery({
    queryKey: ["analytics-insights", base],
    queryFn: () => api<Data>(`/api/analytics?${base}&insights=1`),
    enabled: withInsights && customReady,
    staleTime: 5 * 60_000,
    retry: false,
  });
  React.useEffect(() => setWithInsights(false), [base]);

  const download = async (format: "csv" | "pdf") => {
    setExporting(format);
    try {
      const res = await fetch(`/api/analytics/export?${base}&format=${format}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "Export failed");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `analytics-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const d = q.data;
  const campaignCols: Column<Data["campaigns"][number]>[] = [
    { key: "name", header: "Campaign", cell: (c) => <span className="font-medium">{c.name}</span> },
    { key: "ch", header: "Channel", cell: (c) => <span className="capitalize">{c.channel}</span> },
    { key: "sent", header: "Sent", cell: (c) => c.sent.toLocaleString("en-IN") },
    { key: "del", header: "Delivered", cell: (c) => c.delivered.toLocaleString("en-IN") },
    { key: "rep", header: "Replied", cell: (c) => `${c.replied} (${c.reply_rate_pct}%)` },
    { key: "conv", header: "Converted", cell: (c) => c.converted },
    { key: "rev", header: "Revenue", cell: (c) => inr(c.revenue_inr) },
  ];
  const teamCols: Column<Data["team"][number]>[] = [
    { key: "name", header: "Member", cell: (t) => <span className="font-medium">{t.name}</span> },
    { key: "assigned", header: "Contacts", cell: (t) => t.contacts_assigned },
    { key: "won", header: "Deals won", cell: (t) => t.deals_won },
    { key: "rev", header: "Revenue", cell: (t) => inr(t.revenue_inr) },
    { key: "tasks", header: "Tasks done", cell: (t) => t.tasks_completed },
    { key: "win", header: "Win rate", cell: (t) => `${t.win_rate_pct}%` },
  ];

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Performance across leads, channels, campaigns and revenue."
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!d || !!exporting} onClick={() => download("csv")}>
              <Download className="mr-1 h-4 w-4" /> {exporting === "csv" ? "Exporting…" : "CSV"}
            </Button>
            <Button variant="outline" size="sm" disabled={!d || !!exporting} onClick={() => download("pdf")}>
              <Download className="mr-1 h-4 w-4" /> {exporting === "pdf" ? "Exporting…" : "PDF"}
            </Button>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList>
            <TabsTrigger value="today">Today</TabsTrigger>
            <TabsTrigger value="7d">7 days</TabsTrigger>
            <TabsTrigger value="30d">30 days</TabsTrigger>
            <TabsTrigger value="90d">90 days</TabsTrigger>
            <TabsTrigger value="custom">Custom</TabsTrigger>
          </TabsList>
        </Tabs>
        {range === "custom" ? (
          <div className="flex items-center gap-2">
            <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </div>
        ) : null}
      </div>

      {!customReady ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">Choose a valid start and end date.</p>
      ) : q.isError ? (
        <div className="rounded-lg border p-6 text-center text-sm">
          <p className="text-destructive">{(q.error as Error).message}</p>
          <Button className="mt-3" variant="outline" onClick={() => q.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            {OVERVIEW.map((o) => (
              <Card key={o.key}>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{o.label}</p>
                  {d ? (
                    <>
                      <p className="mt-1 text-2xl font-semibold tabular-nums">{o.money ? inr(d.overview.current[o.key]) : d.overview.current[o.key].toLocaleString("en-IN")}</p>
                      <Change pct={d.overview.change_pct[o.key]} />
                    </>
                  ) : (
                    <Skeleton className="mt-2 h-8 w-20" />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Lead funnel">
              {d ? (
                <>
                  <div className="h-64" role="img" aria-label="Lead funnel chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={d.funnel} layout="vertical" margin={{ left: 8, right: 16 }}>
                        <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
                        <XAxis type="number" tick={{ fill: AXIS, fontSize: 12 }} axisLine={false} tickLine={false} />
                        <YAxis type="category" dataKey="stage" width={80} tick={{ fill: AXIS, fontSize: 12 }} axisLine={false} tickLine={false} />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          cursor={{ fill: "hsl(var(--muted))" }}
                          formatter={(v: number, _n, p) => [`${v} (${(p.payload as Data["funnel"][number]).conversion_from_leads_pct}% of leads)`, "Contacts"]}
                        />
                        <Bar dataKey="count" name="Contacts" fill={C1} radius={[0, 4, 4, 0]} barSize={22} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {d.funnel.slice(1).map((f) => `${f.stage} ${f.conversion_from_previous_pct}%`).join(" · ")} (conversion from previous stage)
                  </p>
                </>
              ) : (
                <Skeleton className="h-64 w-full" />
              )}
            </ChartCard>

            <ChartCard title="Channel comparison">
              {d ? (
                <div className="h-64" role="img" aria-label="Messages sent and replied by channel">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={d.channels} margin={{ left: 0, right: 8 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="channel" tick={{ fill: AXIS, fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: AXIS, fontSize: 12 }} axisLine={false} tickLine={false} width={40} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--muted))" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="sent" name="Sent" fill={C1} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="replied" name="Replied" fill={C2} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <Skeleton className="h-64 w-full" />
              )}
              {d ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Reply rate: {d.channels.map((c) => `${c.channel} ${c.reply_rate_pct}%`).join(" · ")}
                </p>
              ) : null}
            </ChartCard>
          </div>

          <section>
            <h2 className="mb-2 text-base font-semibold">Campaigns</h2>
            <DataTable columns={campaignCols} rows={d?.campaigns} rowKey={(c) => c.id} loading={q.isLoading} empty="No campaigns in this period." />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Revenue attribution">
              {d ? (
                <>
                  <p className="mb-3 text-2xl font-semibold tabular-nums">{inr(d.revenue.total_revenue_inr)}</p>
                  {d.revenue.by_campaign.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No won deals in this period.</p>
                  ) : (
                    <ul className="space-y-3">
                      {d.revenue.by_campaign.slice(0, 8).map((r) => (
                        <li key={r.campaign_id ?? "none"} className="text-sm">
                          <div className="mb-1 flex justify-between gap-2">
                            <span className="truncate">{r.name}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {inr(r.revenue_inr)} · {r.deals} deal{r.deals === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div className="h-2 rounded-full bg-muted">
                            <div className="h-2 rounded-full" style={{ width: `${d.revenue.total_revenue_inr ? (r.revenue_inr / d.revenue.total_revenue_inr) * 100 : 0}%`, background: C1 }} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <Skeleton className="h-40 w-full" />
              )}
            </ChartCard>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">AI insights</CardTitle>
                <Button size="sm" variant="outline" disabled={!d || ins.isFetching} onClick={() => (withInsights ? void ins.refetch() : setWithInsights(true))}>
                  <Sparkles className="mr-1 h-4 w-4" /> {ins.isFetching ? "Analysing…" : withInsights ? "Refresh" : "Generate insights"}
                </Button>
              </CardHeader>
              <CardContent>
                {ins.isFetching && !ins.data ? (
                  <Skeleton className="h-32 w-full" />
                ) : ins.isError ? (
                  <p className="text-sm text-destructive">{(ins.error as Error).message}</p>
                ) : ins.data ? (
                  ins.data.insights ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{ins.data.insights}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">Insights are unavailable right now (AI provider not configured or failed).</p>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">Get an AI-written summary of what is working and what to do next for this period.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <section>
            <h2 className="mb-2 text-base font-semibold">Team performance</h2>
            <DataTable columns={teamCols} rows={d?.team} rowKey={(t) => t.user_id} loading={q.isLoading} empty="No team activity in this period." />
          </section>
        </div>
      )}
    </div>
  );
}
