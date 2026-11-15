import type { NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { applyContactDetails } from "@/lib/channels/adapters/_capture";
import { inboxByToken, webhookGate } from "@/lib/channels/adapters/_route";
import { handleStopEvents } from "@/lib/channels/adapters/_stop";
import { corsHeaders, json, originAllowed } from "@/lib/channels/adapters/_webchat";
import { VISITOR_ID_RE, WEBCHAT_MAX_TEXT, webchatAdapter } from "@/lib/channels/adapters/webchat";
import { processInboundEvents } from "@/lib/channels/inbound";
import { limitOrResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024;

export const OPTIONS = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "webchat");
  const origin = inbox ? originAllowed(req, inbox) : null;
  return json(null, origin ? 204 : 403, origin);
});

/** POST {visitor_id, text, client_id?, name?, email?, phone?} from the widget. Origin allow-list + strict rate limits. */
export const POST = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const gated = await webhookGate(req, "webchat-msg", 60);
  if (gated) return gated;
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "webchat");
  if (!inbox) return json({ success: false, error: "Not found" }, 404, null);
  const origin = originAllowed(req, inbox);
  if (!origin) return json({ success: false, error: "Origin not allowed" }, 403, null);
  const perInbox = await limitOrResponse(`wh:webchat:${inbox.id}`, { limit: 300, windowSec: 60 });
  if (perInbox) return perInbox;

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ success: false, error: "Message too large" }, 413, origin);
  let body: { visitor_id?: unknown; email?: unknown; phone?: unknown; name?: unknown; text?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400, origin);
  }
  if (typeof body.visitor_id !== "string" || !VISITOR_ID_RE.test(body.visitor_id)) return json({ success: false, error: "Invalid visitor id" }, 400, origin);
  if (typeof body.text !== "string" || !body.text.trim()) return json({ success: false, error: "Empty message" }, 400, origin);
  if (body.text.length > WEBCHAT_MAX_TEXT) return json({ success: false, error: `Message is limited to ${WEBCHAT_MAX_TEXT} characters` }, 413, origin);
  const perVisitor = await limitOrResponse(`wh:webchat-v:${inbox.id}:${body.visitor_id}`, { limit: 10, windowSec: 60 });
  if (perVisitor) return perVisitor;

  const events = webchatAdapter.parseInbound(raw);
  const stats = await processInboundEvents(inbox, events);
  if (stats.failed > 0) return json({ success: false, error: "Could not deliver your message, please retry" }, 500, origin);
  if (stats.inserted > 0) {
    await applyContactDetails(inbox.org_id, inbox.id, body.visitor_id, body).catch((e) => console.error("[webchat] contact details failed", e));
    await handleStopEvents(inbox, events).catch((e) => console.error("[webchat] stop handling failed", e));
  }
  return json({ success: true, data: { duplicate: stats.duplicates > 0 && stats.inserted === 0 } }, 200, origin, corsHeaders(origin));
});
