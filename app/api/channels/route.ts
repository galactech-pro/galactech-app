import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { appUrl } from "@/lib/env";
import { connectApi, connectMeta, connectSms, connectTelegram, connectWebchat, providerCleanup, webchatSnippet } from "@/lib/channels/adapters/_connect";
import { normalizeOrigin } from "@/lib/channels/adapters/_webchat";
import { ensureEmailInbox, toInboxCtx } from "@/lib/channels/inbox";
import { inboundAddress } from "@/lib/email/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Connect = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("telegram"), bot_token: z.string().trim().min(10).max(200), name: z.string().trim().max(80).optional() }),
  z.object({ channel: z.literal("messenger"), account_id: z.string().trim().max(40), access_token: z.string().trim().min(20).max(1000), name: z.string().trim().max(80).optional() }),
  z.object({ channel: z.literal("instagram"), account_id: z.string().trim().max(40), access_token: z.string().trim().min(20).max(1000), name: z.string().trim().max(80).optional() }),
  z.object({
    channel: z.literal("sms"),
    account_sid: z.string().trim().max(40),
    auth_token: z.string().trim().min(10).max(100),
    from: z.string().trim().max(20).optional(),
    messaging_service_sid: z.string().trim().max(40).optional(),
    name: z.string().trim().max(80).optional(),
  }),
  z.object({
    channel: z.literal("webchat"),
    name: z.string().trim().max(80).optional(),
    allowed_origins: z.array(z.string().max(200)).min(1).max(20),
    title: z.string().trim().max(60).optional(),
    welcome: z.string().trim().max(200).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    collect_details: z.boolean().optional(),
  }),
  z.object({ channel: z.literal("api") }),
]);

/** Inboxes of the org (never returns credentials) + last inbound time per inbox as a health signal. */
export const GET = withAuth(async (_req, session) => {
  const rows = await prisma.inboxes.findMany({ where: { org_id: session.org_id }, orderBy: { created_at: "asc" } });
  const last = await prisma.conversations.groupBy({ by: ["inbox_id"], where: { org_id: session.org_id }, _max: { last_inbound_at: true } });
  const lastBy = new Map(last.map((l) => [l.inbox_id, l._max.last_inbound_at]));
  const org = await prisma.organisations.findUnique({ where: { id: session.org_id }, select: { wa_phone_number_id: true, wa_access_token: true } });
  let base = "";
  try {
    base = appUrl();
  } catch {
    /* unset in production: URLs omitted */
  }
  const inboxes = rows.filter((r) => r.channel !== "email").map((r) => {
    let cfg: Record<string, unknown> = {};
    let broken = false;
    try {
      cfg = toInboxCtx(r).config;
    } catch {
      broken = true; // undecryptable credentials: shown as needing reconnect
    }
    const url =
      !base ? null
      : r.channel === "telegram" ? `${base}/api/webhooks/telegram/${r.webhook_token}`
      : r.channel === "sms" ? `${base}/api/webhooks/sms/${r.webhook_token}`
      : r.channel === "webchat" ? `${base}/api/webhooks/webchat/${r.webhook_token}`
      : r.channel === "messenger" || r.channel === "instagram" ? `${base}/api/webhooks/meta`
      : r.channel === "api" ? `${base}/api/public/v1/messages`
      : null;
    return {
      id: r.id,
      channel: r.channel,
      provider: r.provider,
      name: r.name,
      identifier: r.identifier.startsWith("webchat:") || r.identifier.startsWith("api:") ? null : r.identifier,
      is_active: r.is_active,
      needs_reconnect: broken,
      created_at: r.created_at,
      last_inbound_at: lastBy.get(r.id) ?? null,
      webhook_url: url,
      snippet: r.channel === "webchat" && base ? webchatSnippet(r.webhook_token) : null,
      allowed_origins: r.channel === "webchat" && Array.isArray(cfg.allowed_origins) ? cfg.allowed_origins : undefined,
    };
  });
  // Every org gets an email inbox + its own inbound address (customer replies arrive in the dashboard)
  let emailAddress: string | null = null;
  try {
    await ensureEmailInbox(session.org_id);
    const em = await prisma.inboxes.findFirst({ where: { org_id: session.org_id, channel: "email", provider: "resend" }, select: { webhook_token: true } });
    emailAddress = em ? inboundAddress(em.webhook_token) : null;
  } catch {
    /* non-fatal */
  }
  return ok({
    email_inbound: { address: emailAddress, configured: !!process.env.INBOUND_EMAIL_DOMAIN && !!process.env.RESEND_WEBHOOK_SECRET },
    inboxes,
    platform: {
      whatsapp: !!(org?.wa_phone_number_id && org?.wa_access_token),
      email: true, // platform Resend key
      voice: true, // platform Vapi env (not verified here)
    },
  });
});

/** Admin only. Connect a channel; credentials are stored AES-GCM encrypted in inboxes.config. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, Connect);
    switch (body.channel) {
      case "telegram": return ok(await connectTelegram(session.org_id, body.bot_token, body.name), 201);
      case "messenger": return ok(await connectMeta(session.org_id, "messenger", body), 201);
      case "instagram": return ok(await connectMeta(session.org_id, "instagram", body), 201);
      case "sms": return ok(await connectSms(session.org_id, body), 201);
      case "webchat": return ok(await connectWebchat(session.org_id, body), 201);
      case "api": return ok(await connectApi(session.org_id), 201);
    }
  },
  { role: "admin", rateLimit: { limit: 20, windowSec: 60 } }
);

const Patch = z.object({
  id: z.string().uuid(),
  allowed_origins: z.array(z.string().max(200)).min(1).max(20).optional(),
  title: z.string().trim().max(60).optional(),
  welcome: z.string().trim().max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  collect_details: z.boolean().optional(),
});

/** Admin only. Update web chat settings (allowed origins, title, colour...). */
export const PATCH = withAuth(
  async (req, session) => {
    const b = await parseBody(req, Patch);
    const row = await prisma.inboxes.findFirst({ where: { id: b.id, org_id: session.org_id, channel: "webchat" } });
    if (!row) throw new ApiError(404, "Web chat inbox not found");
    const cfg = toInboxCtx(row).config;
    if (b.allowed_origins) {
      const o = [...new Set(b.allowed_origins.map((x) => normalizeOrigin(x)).filter((x): x is string => !!x))];
      if (o.length === 0) throw new ApiError(422, "Add at least one valid origin, e.g. https://www.example.com");
      cfg.allowed_origins = o;
    }
    if (b.title !== undefined) cfg.title = b.title;
    if (b.welcome !== undefined) cfg.welcome = b.welcome;
    if (b.color !== undefined) cfg.color = b.color;
    if (b.collect_details !== undefined) cfg.collect_details = b.collect_details;
    await prisma.inboxes.updateMany({ where: { id: row.id, org_id: session.org_id }, data: { config: encrypt(JSON.stringify(cfg)) } });
    return ok({ id: row.id });
  },
  { role: "admin" }
);

/** Admin only. Soft disconnect: is_active=false (history kept). Telegram webhook is removed best-effort. */
export const DELETE = withAuth(
  async (req, session) => {
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get("id"));
    const row = await prisma.inboxes.findFirst({ where: { id, org_id: session.org_id } });
    if (!row) throw new ApiError(404, "Channel not found");
    if (row.provider === "whatsapp_cloud" || row.provider === "resend" || row.provider === "vapi") throw new ApiError(400, "Manage this channel in Settings");
    if (row.channel === "telegram") {
      try {
        await providerCleanup(toInboxCtx(row));
      } catch {
        /* ignore */
      }
    }
    await prisma.inboxes.updateMany({ where: { id: row.id, org_id: session.org_id }, data: { is_active: false } });
    return ok({ id: row.id, is_active: false });
  },
  { role: "admin" }
);
