import { inngest, type Events } from "@/lib/inngest";
import { prisma, type channel } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { PlanLimitError } from "@/lib/limits";
import { localHour } from "@/lib/compliance";
import { applyMergeTags } from "@/lib/utils";
import { sendInteractive, sendMedia, sendMessage, sendTemplate } from "@/lib/whatsapp";
import { sendEmail, renderSimple } from "@/lib/email";
import { initiateCall } from "@/lib/voice";
import { campaignKey, sendOutbound } from "@/lib/channels/outbound";
import { toApiError } from "@/lib/channels/errors";
import { supportsOutbound } from "@/lib/channels/registry";
import { claimCampaignLease, finishCampaign, heartbeatCampaignLease, mergeCampaignStats } from "@/lib/channels/campaign-lease";
import { audienceSchema, audienceWhere, contentSchema, type CampaignContent } from "@/app/api/campaigns/_lib";
import { textToHtmlParagraphs } from "./helpers";

/*
 * Pacing is configurable; NO provider limits are assumed here (WhatsApp throughput/tier limits are UNVERIFIED).
 *   CAMPAIGN_BATCH_SIZE        contacts per durable step            (default 20; voice uses CAMPAIGN_VOICE_BATCH_SIZE, default 5)
 *   CAMPAIGN_BATCH_INTERVAL_MS pause between batches                (default 1000)
 *   CAMPAIGN_SEND_INTERVAL_MS  pause between individual sends       (default 0)
 *   CAMPAIGN_ORG_CONCURRENCY   concurrent runs per org              (default 1)
 *   CAMPAIGN_GLOBAL_CONCURRENCY concurrent runs overall             (default 10)
 */
const num = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const BATCH = Math.max(1, num("CAMPAIGN_BATCH_SIZE", 20));
const VOICE_BATCH = Math.max(1, num("CAMPAIGN_VOICE_BATCH_SIZE", 5));
const BATCH_INTERVAL_MS = num("CAMPAIGN_BATCH_INTERVAL_MS", 1000);
const SEND_INTERVAL_MS = num("CAMPAIGN_SEND_INTERVAL_MS", 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Stop = "limit" | "paused" | "unsupported" | "not_connected" | "lost_lease" | "outside_hours" | null;

interface BatchResult {
  lastId: string | null;
  exhausted: boolean;
  sent: number;
  failed: number;
  skipped: number;
  stop: Stop;
}

/** Compliance outcomes that mean "this contact is not eligible" (skip), as opposed to a delivery failure. */
const SKIP_CODES = new Set(["CONTACT_INACTIVE", "OPTED_OUT", "DNC", "NO_CONSENT", "AUTO_OUTREACH_DISABLED"]);

async function sendOne(
  orgId: string,
  ch: channel,
  content: CampaignContent,
  campaignId: string,
  c: { id: string; full_name: string; phone: string; email: string | null; company: string | null }
): Promise<void> {
  const tags = { full_name: c.full_name, company: c.company, email: c.email, phone: c.phone };
  const key = campaignKey(campaignId, c.id); // per-contact idempotency: resume / step retry can never send twice
  const ctx = { contactId: c.id, campaignId, purpose: "marketing" as const, idempotencyKey: key };
  if (ch === "whatsapp") {
    const body = applyMergeTags(content.body ?? "", tags);
    if (content.template_name) {
      await sendTemplate(orgId, c.phone, content.template_name, (content.template_params ?? []).map((p) => applyMergeTags(p, tags)), { ...ctx, language: content.template_language });
    } else if (content.media_url) {
      await sendMedia(orgId, c.phone, { type: content.media_type ?? "image", url: content.media_url, caption: body }, ctx);
    } else if (content.buttons?.length) {
      await sendInteractive(orgId, c.phone, body, content.buttons, ctx);
    } else {
      await sendMessage(orgId, c.phone, body, ctx);
    }
  } else if (ch === "email") {
    if (!c.email) throw new ApiError(422, "Contact has no email", "NO_ADDRESS");
    const subject = applyMergeTags(content.subject ?? "", tags);
    const html = await renderSimple(subject, textToHtmlParagraphs(applyMergeTags(content.body ?? "", tags)));
    await sendEmail(orgId, { to: c.email, subject, html, contactId: c.id, campaignId, purpose: "marketing", idempotencyKey: key });
  } else if (ch === "voice") {
    // idempotencyKey => a step retry never dials twice; OUTSIDE_CALL_HOURS is raised by the compliance gate
    await initiateCall(orgId, c.id, content.body?.trim() ? applyMergeTags(content.body, tags) : undefined, { campaignId, idempotencyKey: key, purpose: "marketing" });
  } else {
    // other adapters (sms, telegram, ...): plain text through the shared pipeline
    try {
      await sendOutbound({ orgId, contactId: c.id, channel: ch, content: { kind: "text", text: applyMergeTags(content.body ?? "", tags) }, purpose: "marketing", campaignId, idempotencyKey: key });
    } catch (e) {
      throw toApiError(e);
    }
  }
}

async function computeStats(orgId: string, campaignId: string) {
  const rows = await prisma.messages.findMany({
    where: { org_id: orgId, campaign_id: campaignId, direction: "outbound" },
    select: { status: true, opened_at: true, clicked_at: true, replied_at: true },
  });
  return {
    sent: rows.filter((r) => r.status !== "failed" && r.status !== "queued").length,
    failed: rows.filter((r) => r.status === "failed").length,
    delivered: rows.filter((r) => r.status === "delivered" || r.status === "read").length,
    opened: rows.filter((r) => r.opened_at || r.status === "read").length,
    clicked: rows.filter((r) => r.clicked_at).length,
    replied: rows.filter((r) => r.replied_at).length,
    converted: 0,
  };
}

/** Next instant (15-minute resolution, up to 72h ahead) when the org's calling window is open; fallback +1h. */
function nextWindowOpen(tz: string, start: number, end: number): Date {
  const step = 15 * 60_000;
  const t0 = Math.ceil(Date.now() / step) * step;
  for (let i = 0; i < 72 * 4; i++) {
    const t = new Date(t0 + i * step);
    const h = localHour(tz, t);
    if (h >= start && h < end) return t;
  }
  return new Date(Date.now() + 3600_000);
}

export const campaignSend = inngest.createFunction(
  {
    id: "campaign-send",
    retries: 3,
    // One run per org at a time plus a global cap. Concurrency counts steps executing, so a run sleeping (schedule, throttle,
    // calling window) does not hold a slot. Duplicate runs for the SAME campaign are additionally excluded by the lease.
    concurrency: [
      { limit: Math.max(1, num("CAMPAIGN_ORG_CONCURRENCY", 1)), key: "event.data.org_id" },
      { limit: Math.max(1, num("CAMPAIGN_GLOBAL_CONCURRENCY", 10)) },
    ],
  },
  { event: "campaign/send" },
  async ({ event, step }) => {
    const d = event.data as Events["campaign/send"];
    const runId = event.id ?? `${d.campaign_id}:${event.ts ?? 0}`;

    const camp = await step.run("load", async () => {
      const c = await prisma.campaigns.findFirst({ where: { id: d.campaign_id, org_id: d.org_id } });
      if (!c) return null;
      const wait = c.scheduled_at && c.scheduled_at.getTime() > Date.now() + 5000 ? c.scheduled_at.toISOString() : null;
      return { channel: c.channel, status: c.status, wait_until: wait };
    });
    if (!camp) return { skipped: "missing" };
    if (camp.status !== "sending" && camp.status !== "scheduled") return { skipped: `status ${camp.status}` };
    if (!supportsOutbound(camp.channel)) {
      await step.run("unsupported", () => finishCampaign(d.org_id, d.campaign_id, runId, { stopped_reason: "unsupported" }, false));
      return { skipped: "unsupported channel" };
    }

    // Scheduled start. Decisions are memoised step results (deterministic on replay). After waking, re-read: the
    // campaign may have been paused or rescheduled (PATCH scheduled_at) while this run slept.
    let waitIso = camp.wait_until;
    for (let k = 0; k < 3 && waitIso; k++) {
      await step.sleepUntil(`wait-${k}`, new Date(waitIso));
      const re = await step.run(`reload-${k}`, async () => {
        const c = await prisma.campaigns.findFirst({ where: { id: d.campaign_id, org_id: d.org_id }, select: { status: true, scheduled_at: true } });
        if (!c || (c.status !== "scheduled" && c.status !== "sending")) return { stop: true, wait_until: null as string | null };
        const w = c.scheduled_at && c.scheduled_at.getTime() > Date.now() + 5000 ? c.scheduled_at.toISOString() : null;
        return { stop: false, wait_until: w };
      });
      if (re.stop) return { skipped: "paused or changed while waiting" };
      waitIso = re.wait_until;
    }

    const total = await step.run("claim", async () => {
      // atomic: scheduled|sending -> sending owned by this run; false if another live run owns it or it was paused
      const got = await claimCampaignLease(d.org_id, d.campaign_id, runId);
      if (!got) return -1;
      const c = await prisma.campaigns.findFirst({ where: { id: d.campaign_id, org_id: d.org_id } });
      if (!c) return -1;
      const filter = audienceSchema.safeParse(c.audience_filter);
      const n = await prisma.contacts.count({ where: audienceWhere(d.org_id, c.channel, filter.success ? filter.data : { all: true }) });
      await mergeCampaignStats(d.org_id, c.id, { total: n }); // never zeroes sent/failed/skipped (resume keeps history)
      return n;
    });
    if (total < 0) return { skipped: "another run owns this campaign, or it is paused/sent" };

    const totals = { sent: 0, failed: 0, skipped: 0 };
    let cursor: string | null = null;
    let stop: Stop = null;
    const batchSize = camp.channel === "voice" ? VOICE_BATCH : BATCH;

    for (let i = 0; i < 20000; i++) {
      const r: BatchResult = await step.run(`batch-${i}`, async () => {
        const empty: BatchResult = { lastId: cursor, exhausted: false, sent: 0, failed: 0, skipped: 0, stop: null };
        if (!(await heartbeatCampaignLease(d.org_id, d.campaign_id, runId))) {
          const cur = await prisma.campaigns.findFirst({ where: { id: d.campaign_id, org_id: d.org_id }, select: { status: true } });
          return { ...empty, stop: cur?.status === "paused" ? ("paused" as const) : ("lost_lease" as const) };
        }
        const c = await prisma.campaigns.findFirst({ where: { id: d.campaign_id, org_id: d.org_id } });
        if (!c) return { ...empty, stop: "lost_lease" as const };
        const filter = audienceSchema.safeParse(c.audience_filter);
        const where = audienceWhere(d.org_id, c.channel, filter.success ? filter.data : { all: true });
        const content = contentSchema.safeParse(c.content);
        const contentData: CampaignContent = content.success ? content.data : {};
        const rows = await prisma.contacts.findMany({
          where: { AND: [where, ...(cursor ? [{ id: { gt: cursor } }] : [])] },
          orderBy: { id: "asc" },
          take: batchSize,
          select: { id: true, full_name: true, phone: true, email: true, company: true },
        });
        const out: BatchResult = { ...empty, exhausted: rows.length < batchSize };
        if (rows.length === 0) return { ...out, exhausted: true };

        // resume / retry: contacts that already have an outbound message for this campaign are skipped (and never re-sent)
        const already = new Set(
          (
            await prisma.messages.findMany({
              where: { org_id: d.org_id, campaign_id: c.id, direction: "outbound", contact_id: { in: rows.map((r) => r.id) } },
              select: { contact_id: true },
            })
          ).map((m) => m.contact_id)
        );

        for (const row of rows) {
          if (already.has(row.id)) {
            out.lastId = row.id;
            continue; // not counted as skipped: it was already sent by an earlier pass
          }
          try {
            await sendOne(d.org_id, c.channel, contentData, c.id, row);
            out.sent++;
          } catch (e) {
            if (e instanceof PlanLimitError) {
              out.stop = "limit";
              break;
            }
            const code = e instanceof ApiError ? e.code : undefined;
            if (code === "OUTSIDE_CALL_HOURS") {
              out.stop = "outside_hours"; // reschedule (sleep until the window opens) instead of failing the contact
              break;
            }
            if (code && SKIP_CODES.has(code)) out.skipped++;
            else {
              if (e instanceof ApiError && e.status === 400 && /not (connected|configured)/i.test(e.message)) {
                out.stop = "not_connected";
                break;
              }
              if (!(e instanceof ApiError)) console.error("[campaign-send] unexpected", e);
              out.failed++;
            }
          }
          out.lastId = row.id;
          if (SEND_INTERVAL_MS > 0) await sleep(SEND_INTERVAL_MS);
        }

        const stats = await computeStats(d.org_id, c.id);
        await mergeCampaignStats(d.org_id, c.id, stats, out.skipped);
        return out;
      });

      totals.sent += r.sent;
      totals.failed += r.failed;
      totals.skipped += r.skipped;
      if (r.lastId) cursor = r.lastId;

      if (r.stop === "outside_hours") {
        const resumeAt = await step.run(`window-${i}`, async () => {
          const org = await prisma.organisations.findUnique({ where: { id: d.org_id }, select: { timezone: true, call_window_start: true, call_window_end: true } });
          return (org ? nextWindowOpen(org.timezone, org.call_window_start, org.call_window_end) : new Date(Date.now() + 3600_000)).toISOString();
        });
        await step.sleepUntil(`window-wait-${i}`, new Date(resumeAt));
        continue; // same cursor: the blocked contact is retried when the window is open
      }
      if (r.stop) {
        stop = r.stop;
        break;
      }
      if (r.exhausted) break;
      if (BATCH_INTERVAL_MS > 0) await step.sleep(`throttle-${i}`, BATCH_INTERVAL_MS);
    }

    if (stop === "lost_lease") return { ...totals, stopped: stop }; // another run (or a pause) owns the campaign now

    await step.run("finalize", async () => {
      const stats = await computeStats(d.org_id, d.campaign_id);
      // not "done" when stopped by limit/paused/unsupported/not_connected; resume re-runs and skips contacts already messaged
      await finishCampaign(d.org_id, d.campaign_id, runId, { ...stats, ...(stop ? { stopped_reason: stop } : {}) }, !stop);
    });
    return { ...totals, stopped: stop };
  }
);
