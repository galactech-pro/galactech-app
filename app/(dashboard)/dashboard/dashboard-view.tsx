"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight, ArrowUpRight, CalendarCheck, IndianRupee, Mail, MessageCircle, Phone, Rocket, Send, Sparkles, UserPlus, Users, Workflow,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/app/page-header";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import type { ActivityItem, OverviewStats } from "@/app/api/stats/overview/route";

const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

function timeAgo(iso: string) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Delta({ now, prev }: { now: number; prev: number }) {
  if (now === prev) return <span className="text-xs text-muted-foreground">same as yesterday</span>;
  const up = now > prev;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", up ? "text-green-700" : "text-red-700")}>
      <Icon className="h-3 w-3" />
      {Math.abs(now - prev)} vs yesterday
    </span>
  );
}

function StatCard({
  label, value, icon: Icon, footer, loading,
}: { label: string; value: string; icon: LucideIcon; footer: React.ReactNode; loading: boolean }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{label}</p>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-foreground">
            <Icon className="h-4 w-4" />
          </span>
        </div>
        {loading ? <Skeleton className="mt-3 h-8 w-24" /> : <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>}
        <div className="mt-1 min-h-4">{loading ? null : footer}</div>
      </CardContent>
    </Card>
  );
}

const ACT_ICON: Record<ActivityItem["type"], LucideIcon> = {
  message_in: MessageCircle,
  message_out: Send,
  call: Phone,
  lead: UserPlus,
  deal_won: IndianRupee,
};

const QUICK: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/contacts", label: "Add or import contacts", icon: Users },
  { href: "/campaigns", label: "New campaign", icon: Rocket },
  { href: "/automations", label: "Build an automation", icon: Workflow },
  { href: "/voice", label: "Start an AI call", icon: Phone },
  { href: "/inbox", label: "Open inbox", icon: Mail },
];

export function DashboardView({ name }: { name: string | null }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["stats", "overview"], queryFn: () => api<OverviewStats>("/api/stats/overview"), refetchInterval: 60_000 });
  const t = data?.today;
  const y = data?.yesterday;

  const insights: { text: string; href: string }[] = [];
  if (data) {
    if (data.insights.hot_leads_uncontacted > 0)
      insights.push({ text: `${data.insights.hot_leads_uncontacted} high-scoring lead${data.insights.hot_leads_uncontacted > 1 ? "s" : ""} (7+) haven't been contacted yet. Reach out while they're warm.`, href: "/contacts" });
    if (data.insights.unreplied_inbound > 0)
      insights.push({ text: `${data.insights.unreplied_inbound} inbound message${data.insights.unreplied_inbound > 1 ? "s" : ""} in the last 48 hours. Fast replies convert better.`, href: "/inbox" });
    if (data.insights.overdue_tasks > 0)
      insights.push({ text: `${data.insights.overdue_tasks} overdue follow-up task${data.insights.overdue_tasks > 1 ? "s" : ""} need attention.`, href: "/contacts" });
    if (data.insights.open_pipeline_inr > 0)
      insights.push({ text: `${inr(data.insights.open_pipeline_inr)} is sitting in your open pipeline.`, href: "/analytics" });
  }

  return (
    <div>
      <PageHeader
        title={name ? `Welcome back, ${name}` : "Dashboard"}
        description="Here's what's happening across WhatsApp, email and voice today."
        actions={
          <Button asChild>
            <Link href="/campaigns">
              <Rocket /> New campaign
            </Link>
          </Button>
        }
      />

      {error ? (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Couldn&apos;t load stats: {error.message}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard loading={isLoading} label="Messages sent today" value={String(t?.messages_sent ?? 0)} icon={Send} footer={t && y ? <Delta now={t.messages_sent} prev={y.messages_sent} /> : null} />
        <StatCard loading={isLoading} label="Calls made" value={String(t?.calls_made ?? 0)} icon={Phone} footer={t && y ? <Delta now={t.calls_made} prev={y.calls_made} /> : null} />
        <StatCard loading={isLoading} label="Emails opened" value={String(t?.emails_opened ?? 0)} icon={Mail} footer={t && y ? <Delta now={t.emails_opened} prev={y.emails_opened} /> : null} />
        <StatCard loading={isLoading} label="New leads" value={String(t?.new_leads ?? 0)} icon={UserPlus} footer={t && y ? <Delta now={t.new_leads} prev={y.new_leads} /> : null} />
        <StatCard
          loading={isLoading}
          label="Revenue this month"
          value={inr(data?.revenue.month_inr ?? 0)}
          icon={IndianRupee}
          footer={<span className="text-xs text-muted-foreground">{data?.revenue.deals_won_month ?? 0} deals won</span>}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Latest messages, calls, leads and wins.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : data && data.activity.length > 0 ? (
              <ul className="divide-y">
                {data.activity.map((a) => {
                  const Icon = ACT_ICON[a.type];
                  return (
                    <li key={a.id}>
                      <Link href={a.href} className="flex items-start gap-3 rounded-md py-3 hover:bg-muted/50">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{a.title}</span>
                          {a.detail ? <span className="block truncate text-xs text-muted-foreground">{a.detail}</span> : null}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(a.at)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <CalendarCheck className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No activity yet</p>
                <p className="text-sm text-muted-foreground">Import contacts and send your first campaign to see activity here.</p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/contacts">Add contacts</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="bg-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-muted-foreground" /> AI insights
              </CardTitle>
              <CardDescription>Based on your live pipeline.</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : insights.length > 0 ? (
                <ul className="space-y-3">
                  {insights.map((i) => (
                    <li key={i.text} className="text-sm">
                      <Link href={i.href} className="hover:underline">{i.text}</Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">You&apos;re all caught up. Insights appear as leads and conversations come in.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick actions</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1">
              {QUICK.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Icon className="h-4 w-4 text-primary" />
                  {label}
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
