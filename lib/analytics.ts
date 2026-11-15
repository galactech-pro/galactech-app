import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";

export const RangeQuery = z.object({
  range: z.enum(["today", "7d", "30d", "90d", "custom"]).default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
  insights: z.enum(["0", "1"]).optional(),
});

export interface DateRange {
  from: Date;
  to: Date;
}

export function resolveRange(q: z.infer<typeof RangeQuery>): DateRange {
  const to = new Date();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  switch (q.range) {
    case "today":
      return { from: start, to };
    case "7d":
      start.setDate(start.getDate() - 6);
      return { from: start, to };
    case "30d":
      start.setDate(start.getDate() - 29);
      return { from: start, to };
    case "90d":
      start.setDate(start.getDate() - 89);
      return { from: start, to };
    case "custom": {
      if (!q.from || !q.to) throw new ApiError(422, "from and to are required for custom range");
      const f = new Date(q.from);
      const t = new Date(q.to);
      if (isNaN(+f) || isNaN(+t) || f > t) throw new ApiError(422, "Invalid custom date range");
      t.setHours(23, 59, 59, 999);
      return { from: f, to: t };
    }
  }
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const num = (d: unknown) => Number(d ?? 0);

export async function getOverview(orgId: string, r: DateRange) {
  const span = r.to.getTime() - r.from.getTime();
  const prev = { from: new Date(r.from.getTime() - span), to: new Date(r.from.getTime()) };
  const metrics = async (d: DateRange) => {
    const inRange = { gte: d.from, lte: d.to };
    const [leads, sent, replied, won, revenue, calls] = await Promise.all([
      prisma.contacts.count({ where: { org_id: orgId, created_at: inRange } }),
      prisma.messages.count({ where: { org_id: orgId, direction: "outbound", created_at: inRange } }),
      prisma.messages.count({ where: { org_id: orgId, direction: "inbound", created_at: inRange } }),
      prisma.deals.count({ where: { org_id: orgId, stage: "won", closed_at: inRange } }),
      prisma.deals.aggregate({ where: { org_id: orgId, stage: "won", closed_at: inRange }, _sum: { value_inr: true } }),
      prisma.ai_calls.count({ where: { org_id: orgId, created_at: inRange } }),
    ]);
    return { leads, messages_sent: sent, replies: replied, deals_won: won, revenue_inr: num(revenue._sum.value_inr), ai_calls: calls };
  };
  const [cur, old] = await Promise.all([metrics(r), metrics(prev)]);
  const delta = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
  return {
    current: cur,
    previous: old,
    change_pct: {
      leads: delta(cur.leads, old.leads),
      messages_sent: delta(cur.messages_sent, old.messages_sent),
      replies: delta(cur.replies, old.replies),
      deals_won: delta(cur.deals_won, old.deals_won),
      revenue_inr: delta(cur.revenue_inr, old.revenue_inr),
      ai_calls: delta(cur.ai_calls, old.ai_calls),
    },
  };
}

/** Cumulative funnel from contacts.status (leads created in range). */
export async function getFunnel(orgId: string, r: DateRange) {
  const groups = await prisma.contacts.groupBy({
    by: ["status"],
    where: { org_id: orgId, created_at: { gte: r.from, lte: r.to } },
    _count: { _all: true },
  });
  const c = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  const leads = groups.reduce((a, g) => a + g._count._all, 0);
  const contacted = leads - c("new");
  const qualified = c("qualified") + c("demo") + c("won");
  const demo = c("demo") + c("won");
  const closed = c("won");
  const stages = [
    { stage: "leads", count: leads },
    { stage: "contacted", count: contacted },
    { stage: "qualified", count: qualified },
    { stage: "demo", count: demo },
    { stage: "closed", count: closed },
  ];
  return stages.map((s, i) => ({
    ...s,
    conversion_from_previous_pct: i === 0 ? 100 : pct(s.count, stages[i - 1].count),
    conversion_from_leads_pct: pct(s.count, leads),
  }));
}

export async function getChannelComparison(orgId: string, r: DateRange) {
  const where = { org_id: orgId, direction: "outbound" as const, created_at: { gte: r.from, lte: r.to } };
  const [sent, delivered, replied, opened] = await Promise.all([
    prisma.messages.groupBy({ by: ["channel"], where, _count: { _all: true } }),
    prisma.messages.groupBy({ by: ["channel"], where: { ...where, status: { in: ["delivered", "read"] } }, _count: { _all: true } }),
    prisma.messages.groupBy({ by: ["channel"], where: { ...where, replied_at: { not: null } }, _count: { _all: true } }),
    prisma.messages.groupBy({ by: ["channel"], where: { ...where, OR: [{ opened_at: { not: null } }, { status: "read" }] }, _count: { _all: true } }),
  ]);
  const get = (arr: { channel: string; _count: { _all: number } }[], ch: string) => arr.find((x) => x.channel === ch)?._count._all ?? 0;
  const channels = (["whatsapp", "email", "voice", "sms"] as const).map((ch) => {
    const s = get(sent, ch);
    return {
      channel: ch,
      sent: s,
      delivered: get(delivered, ch),
      opened: get(opened, ch),
      replied: get(replied, ch),
      reply_rate_pct: pct(get(replied, ch), s),
      open_rate_pct: pct(get(opened, ch), s),
    };
  });
  const calls = await prisma.ai_calls.groupBy({ by: ["outcome"], where: { org_id: orgId, created_at: { gte: r.from, lte: r.to } }, _count: { _all: true } });
  const totalCalls = calls.reduce((a, c) => a + c._count._all, 0);
  const interested = calls.find((c) => c.outcome === "interested")?._count._all ?? 0;
  const v = channels.find((c) => c.channel === "voice")!;
  v.sent = totalCalls;
  v.replied = interested;
  v.reply_rate_pct = pct(interested, totalCalls);
  return channels;
}

export async function getCampaignTable(orgId: string, r: DateRange) {
  const campaigns = await prisma.campaigns.findMany({
    where: { org_id: orgId, created_at: { gte: r.from, lte: r.to } },
    orderBy: { created_at: "desc" },
    take: 100,
  });
  const revenue = await prisma.deals.groupBy({
    by: ["source_campaign_id"],
    where: { org_id: orgId, stage: "won", source_campaign_id: { in: campaigns.map((c) => c.id) } },
    _sum: { value_inr: true },
  });
  return campaigns.map((c) => {
    const s = (c.stats ?? {}) as Record<string, number>;
    const total = s.total ?? s.sent ?? 0;
    return {
      id: c.id,
      name: c.name,
      channel: c.channel,
      status: c.status,
      sent_at: c.sent_at,
      total,
      sent: s.sent ?? 0,
      delivered: s.delivered ?? 0,
      opened: s.opened ?? 0,
      clicked: s.clicked ?? 0,
      replied: s.replied ?? 0,
      converted: s.converted ?? 0,
      reply_rate_pct: pct(s.replied ?? 0, s.sent ?? total),
      revenue_inr: num(revenue.find((x) => x.source_campaign_id === c.id)?._sum.value_inr),
    };
  });
}

export async function getRevenueAttribution(orgId: string, r: DateRange) {
  const deals = await prisma.deals.findMany({
    where: { org_id: orgId, stage: "won", closed_at: { gte: r.from, lte: r.to } },
    select: { value_inr: true, source_campaign_id: true, campaign: { select: { name: true, channel: true } } },
  });
  const map = new Map<string, { campaign_id: string | null; name: string; channel: string | null; deals: number; revenue_inr: number }>();
  for (const d of deals) {
    const key = d.source_campaign_id ?? "none";
    const e = map.get(key) ?? { campaign_id: d.source_campaign_id, name: d.campaign?.name ?? "Direct / unattributed", channel: d.campaign?.channel ?? null, deals: 0, revenue_inr: 0 };
    e.deals++;
    e.revenue_inr += num(d.value_inr);
    map.set(key, e);
  }
  const rows = [...map.values()].sort((a, b) => b.revenue_inr - a.revenue_inr);
  return { total_revenue_inr: rows.reduce((a, x) => a + x.revenue_inr, 0), by_campaign: rows };
}

export async function getTeamPerformance(orgId: string, r: DateRange) {
  const inRange = { gte: r.from, lte: r.to };
  const users = await prisma.users.findMany({ where: { org_id: orgId, is_active: true }, select: { id: true, full_name: true, email: true, role: true } });
  const [assigned, won, tasksDone, notes] = await Promise.all([
    prisma.contacts.groupBy({ by: ["assigned_to"], where: { org_id: orgId, assigned_to: { not: null }, created_at: inRange }, _count: { _all: true } }),
    prisma.deals.groupBy({ by: ["assigned_to"], where: { org_id: orgId, stage: "won", closed_at: inRange, assigned_to: { not: null } }, _count: { _all: true }, _sum: { value_inr: true } }),
    prisma.tasks.groupBy({ by: ["assigned_to"], where: { org_id: orgId, done: true, assigned_to: { not: null } }, _count: { _all: true } }),
    prisma.notes.groupBy({ by: ["user_id"], where: { org_id: orgId, created_at: inRange }, _count: { _all: true } }),
  ]);
  return users.map((u) => {
    const w = won.find((x) => x.assigned_to === u.id);
    const a = assigned.find((x) => x.assigned_to === u.id)?._count._all ?? 0;
    return {
      user_id: u.id,
      name: u.full_name ?? u.email,
      role: u.role,
      contacts_assigned: a,
      deals_won: w?._count._all ?? 0,
      revenue_inr: num(w?._sum.value_inr),
      tasks_completed: tasksDone.find((x) => x.assigned_to === u.id)?._count._all ?? 0,
      notes_added: notes.find((x) => x.user_id === u.id)?._count._all ?? 0,
      win_rate_pct: pct(w?._count._all ?? 0, a),
    };
  });
}

export async function getAnalytics(orgId: string, r: DateRange) {
  const [overview, funnel, channels, campaigns, revenue, team] = await Promise.all([
    getOverview(orgId, r),
    getFunnel(orgId, r),
    getChannelComparison(orgId, r),
    getCampaignTable(orgId, r),
    getRevenueAttribution(orgId, r),
    getTeamPerformance(orgId, r),
  ]);
  return { range: { from: r.from.toISOString(), to: r.to.toISOString() }, overview, funnel, channels, campaigns, revenue, team };
}

export type AnalyticsPayload = Awaited<ReturnType<typeof getAnalytics>>;

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  // neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\r\n");
}

export function analyticsToCsv(a: AnalyticsPayload): string {
  const parts: string[] = [];
  parts.push("GalacTech analytics report", `Range,${a.range.from},${a.range.to}`, "");
  parts.push("Overview", toCsv(["metric", "current", "previous", "change_pct"], Object.keys(a.overview.current).map((k) => [k, (a.overview.current as Record<string, number>)[k], (a.overview.previous as Record<string, number>)[k], (a.overview.change_pct as Record<string, number | null>)[k]])), "");
  parts.push("Funnel", toCsv(["stage", "count", "conversion_from_previous_pct", "conversion_from_leads_pct"], a.funnel.map((f) => [f.stage, f.count, f.conversion_from_previous_pct, f.conversion_from_leads_pct])), "");
  parts.push("Channels", toCsv(["channel", "sent", "delivered", "opened", "replied", "reply_rate_pct", "open_rate_pct"], a.channels.map((c) => [c.channel, c.sent, c.delivered, c.opened, c.replied, c.reply_rate_pct, c.open_rate_pct])), "");
  parts.push("Campaigns", toCsv(["name", "channel", "status", "sent", "delivered", "opened", "replied", "converted", "revenue_inr"], a.campaigns.map((c) => [c.name, c.channel, c.status, c.sent, c.delivered, c.opened, c.replied, c.converted, c.revenue_inr])), "");
  parts.push("Revenue attribution", toCsv(["campaign", "deals", "revenue_inr"], a.revenue.by_campaign.map((c) => [c.name, c.deals, c.revenue_inr])), "");
  parts.push("Team", toCsv(["name", "role", "contacts_assigned", "deals_won", "revenue_inr", "tasks_completed", "win_rate_pct"], a.team.map((t) => [t.name, t.role, t.contacts_assigned, t.deals_won, t.revenue_inr, t.tasks_completed, t.win_rate_pct])));
  return parts.join("\r\n");
}

/** Minimal single/multi-page text PDF (Helvetica, no dependencies). ASCII only. */
export function simplePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
  const perPage = 52;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([""]);
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((pl, i) => {
    const content = `BT /F1 10 Tf 40 800 Td 14 TL ${pl.map((l) => `(${esc(l.slice(0, 110))}) Tj T*`).join(" ")} ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

export function analyticsToPdfLines(a: AnalyticsPayload): string[] {
  const L: string[] = ["GalacTech - Analytics Report", `Range: ${a.range.from.slice(0, 10)} to ${a.range.to.slice(0, 10)}`, ""];
  L.push("OVERVIEW");
  for (const [k, v] of Object.entries(a.overview.current)) L.push(`  ${k}: ${v}  (change ${a.overview.change_pct[k as keyof typeof a.overview.change_pct] ?? "n/a"}%)`);
  L.push("", "FUNNEL");
  for (const f of a.funnel) L.push(`  ${f.stage}: ${f.count} (${f.conversion_from_previous_pct}% of previous)`);
  L.push("", "CHANNELS");
  for (const c of a.channels) L.push(`  ${c.channel}: sent ${c.sent}, replied ${c.replied}, reply rate ${c.reply_rate_pct}%`);
  L.push("", `REVENUE (total INR ${a.revenue.total_revenue_inr})`);
  for (const c of a.revenue.by_campaign.slice(0, 15)) L.push(`  ${c.name}: ${c.deals} deals, INR ${c.revenue_inr}`);
  L.push("", "CAMPAIGNS");
  for (const c of a.campaigns.slice(0, 20)) L.push(`  ${c.name} [${c.channel}] sent ${c.sent}, replied ${c.replied}, INR ${c.revenue_inr}`);
  L.push("", "TEAM");
  for (const t of a.team) L.push(`  ${t.name}: won ${t.deals_won}, INR ${t.revenue_inr}, tasks ${t.tasks_completed}`);
  return L;
}
