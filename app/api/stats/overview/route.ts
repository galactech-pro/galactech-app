import { ok, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";

const IST_OFFSET_MS = 5.5 * 3600_000;

/** Start of the current day in IST, as a UTC Date. */
function startOfTodayIST(): Date {
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

export interface ActivityItem {
  id: string;
  type: "message_in" | "message_out" | "call" | "lead" | "deal_won";
  title: string;
  detail: string | null;
  at: string;
  href: string;
}

export interface OverviewStats {
  today: {
    messages_sent: number;
    calls_made: number;
    emails_opened: number;
    new_leads: number;
  };
  yesterday: { messages_sent: number; calls_made: number; emails_opened: number; new_leads: number };
  revenue: { month_inr: number; total_inr: number; deals_won_month: number };
  insights: { hot_leads_uncontacted: number; unreplied_inbound: number; overdue_tasks: number; open_pipeline_inr: number };
  activity: ActivityItem[];
}

export const GET = withAuth(async (_req, session) => {
  const orgId = session.org_id;
  const t0 = startOfTodayIST();
  const y0 = new Date(t0.getTime() - 86_400_000);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const day = (from: Date, to?: Date) => ({ gte: from, ...(to ? { lt: to } : {}) });

  const [
    sentT, sentY, callsT, callsY, openedT, openedY, leadsT, leadsY,
    wonMonth, wonTotal, hot, inboundRecent, overdue, pipeline,
    recentMsgs, recentCalls, recentLeads, recentWon,
  ] = await Promise.all([
    prisma.messages.count({ where: { org_id: orgId, direction: "outbound", created_at: day(t0) } }),
    prisma.messages.count({ where: { org_id: orgId, direction: "outbound", created_at: day(y0, t0) } }),
    prisma.ai_calls.count({ where: { org_id: orgId, created_at: day(t0) } }),
    prisma.ai_calls.count({ where: { org_id: orgId, created_at: day(y0, t0) } }),
    prisma.messages.count({ where: { org_id: orgId, channel: "email", opened_at: day(t0) } }),
    prisma.messages.count({ where: { org_id: orgId, channel: "email", opened_at: day(y0, t0) } }),
    prisma.contacts.count({ where: { org_id: orgId, is_active: true, created_at: day(t0) } }),
    prisma.contacts.count({ where: { org_id: orgId, is_active: true, created_at: day(y0, t0) } }),
    prisma.deals.aggregate({
      where: { org_id: orgId, stage: "won", closed_at: { gte: monthStart } },
      _sum: { value_inr: true },
      _count: true,
    }),
    prisma.deals.aggregate({ where: { org_id: orgId, stage: "won" }, _sum: { value_inr: true } }),
    prisma.contacts.count({
      where: { org_id: orgId, is_active: true, lead_score: { gte: 7 }, status: "new", last_contacted_at: null },
    }),
    prisma.messages.count({
      where: { org_id: orgId, direction: "inbound", created_at: { gte: new Date(Date.now() - 2 * 86_400_000) } },
    }),
    prisma.tasks.count({ where: { org_id: orgId, done: false, due_at: { lt: new Date() } } }),
    prisma.deals.aggregate({
      where: { org_id: orgId, stage: { in: ["lead", "qualified", "demo", "proposal"] } },
      _sum: { value_inr: true },
    }),
    prisma.messages.findMany({
      where: { org_id: orgId },
      orderBy: { created_at: "desc" },
      take: 8,
      select: { id: true, direction: true, channel: true, content: true, created_at: true, contact: { select: { id: true, full_name: true } } },
    }),
    prisma.ai_calls.findMany({
      where: { org_id: orgId },
      orderBy: { created_at: "desc" },
      take: 5,
      select: { id: true, outcome: true, status: true, summary: true, created_at: true, contact: { select: { full_name: true } } },
    }),
    prisma.contacts.findMany({
      where: { org_id: orgId, is_active: true },
      orderBy: { created_at: "desc" },
      take: 5,
      select: { id: true, full_name: true, source: true, created_at: true },
    }),
    prisma.deals.findMany({
      where: { org_id: orgId, stage: "won" },
      orderBy: { closed_at: "desc" },
      take: 3,
      select: { id: true, title: true, value_inr: true, closed_at: true, created_at: true },
    }),
  ]);

  const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const activity: ActivityItem[] = [
    ...recentMsgs.map<ActivityItem>((m) => ({
      id: `m-${m.id}`,
      type: m.direction === "inbound" ? "message_in" : "message_out",
      title: m.direction === "inbound" ? `${m.contact.full_name} replied on ${m.channel}` : `Sent ${m.channel} to ${m.contact.full_name}`,
      detail: clip(m.content),
      at: m.created_at.toISOString(),
      href: "/inbox",
    })),
    ...recentCalls.map<ActivityItem>((c) => ({
      id: `c-${c.id}`,
      type: "call",
      title: `AI call with ${c.contact.full_name}${c.outcome ? ` - ${c.outcome.replace("_", " ")}` : ` (${c.status.replace("_", " ")})`}`,
      detail: c.summary ? clip(c.summary) : null,
      at: c.created_at.toISOString(),
      href: "/voice",
    })),
    ...recentLeads.map<ActivityItem>((l) => ({
      id: `l-${l.id}`,
      type: "lead",
      title: `New lead: ${l.full_name}`,
      detail: l.source ? `Source: ${l.source}` : null,
      at: l.created_at.toISOString(),
      href: `/contacts/${l.id}`,
    })),
    ...recentWon.map<ActivityItem>((d) => ({
      id: `d-${d.id}`,
      type: "deal_won",
      title: `Deal won: ${d.title}`,
      detail: `₹${Number(d.value_inr).toLocaleString("en-IN")}`,
      at: (d.closed_at ?? d.created_at).toISOString(),
      href: "/analytics",
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12);

  const data: OverviewStats = {
    today: { messages_sent: sentT, calls_made: callsT, emails_opened: openedT, new_leads: leadsT },
    yesterday: { messages_sent: sentY, calls_made: callsY, emails_opened: openedY, new_leads: leadsY },
    revenue: {
      month_inr: Number(wonMonth._sum.value_inr ?? 0),
      total_inr: Number(wonTotal._sum.value_inr ?? 0),
      deals_won_month: wonMonth._count,
    },
    insights: {
      hot_leads_uncontacted: hot,
      unreplied_inbound: inboundRecent,
      overdue_tasks: overdue,
      open_pipeline_inr: Number(pipeline._sum.value_inr ?? 0),
    },
    activity,
  };
  return ok(data);
});
