import type { NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { prisma } from "@/lib/db";
import { inboxByToken, webhookGate } from "@/lib/channels/adapters/_route";
import { json, originAllowed, publicConfig } from "@/lib/channels/adapters/_webchat";
import { VISITOR_ID_RE } from "@/lib/channels/adapters/webchat";
import { limitOrResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "webchat");
  const origin = inbox ? originAllowed(req, inbox) : null;
  return json(null, origin ? 204 : 403, origin);
});

/**
 * GET ?visitor_id=...&after=<epoch ms>&init=1 -> {config?, messages:[{id, from, text, at}]}.
 * init=1 returns the widget settings and the visitor's history (both directions); later polls return only
 * agent messages created at/after `after` (the client de-duplicates by id). Text is plain text: the widget must
 * render it with textContent.
 */
export const GET = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const gated = await webhookGate(req, "webchat-poll", 300);
  if (gated) return gated;
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "webchat");
  if (!inbox) return json({ success: false, error: "Not found" }, 404, null);
  const origin = originAllowed(req, inbox);
  if (!origin) return json({ success: false, error: "Origin not allowed" }, 403, null);

  const q = req.nextUrl.searchParams;
  const visitor = q.get("visitor_id") ?? "";
  if (!VISITOR_ID_RE.test(visitor)) return json({ success: false, error: "Invalid visitor id" }, 400, origin);
  const limited = await limitOrResponse(`wh:webchat-poll:${inbox.id}:${visitor}`, { limit: 40, windowSec: 60 });
  if (limited) return limited;

  const init = q.get("init") === "1";
  const afterMs = Number(q.get("after") ?? "0");
  const after = Number.isFinite(afterMs) && afterMs > 0 ? new Date(afterMs) : new Date(0);

  const ci = await prisma.contact_inboxes.findUnique({ where: { inbox_id_source_id: { inbox_id: inbox.id, source_id: visitor } }, select: { contact_id: true } });
  const data: { config?: ReturnType<typeof publicConfig>; messages: { id: string; from: "agent" | "visitor"; text: string; at: number }[] } = { messages: [] };
  if (init) data.config = publicConfig(inbox);
  if (ci) {
    const rows = await prisma.messages.findMany({
      where: {
        org_id: inbox.org_id,
        inbox_id: inbox.id,
        contact_id: ci.contact_id,
        status: { not: "failed" },
        ...(init ? {} : { direction: "outbound", created_at: { gte: after } }),
      },
      orderBy: { created_at: init ? "desc" : "asc" },
      take: init ? 50 : 100,
      select: { id: true, direction: true, content: true, created_at: true },
    });
    if (init) rows.reverse();
    data.messages = rows.map((m) => ({ id: m.id, from: m.direction === "outbound" ? "agent" : "visitor", text: (m.content ?? "").slice(0, 2000), at: m.created_at.getTime() }));
  }
  return json({ success: true, data }, 200, origin);
});
