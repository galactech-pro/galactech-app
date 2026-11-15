import { NextResponse, type NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { telegramAdapter } from "@/lib/channels/adapters/telegram";
import { inboxByToken, notFound, webhookGate } from "@/lib/channels/adapters/_route";
import { handleStopEvents } from "@/lib/channels/adapters/_stop";
import { processInboundEvents } from "@/lib/channels/inbound";
import { limitOrResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 256 * 1024;

/**
 * Telegram webhook, one URL per bot (per-inbox token). The secret_token header is checked in constant time against
 * the per-inbox secret we registered via setWebhook. 500 on processing failure so Telegram retries (events already
 * processed are skipped by the webhook_events claim).
 */
export const POST = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const gated = await webhookGate(req, "telegram");
  if (gated) return gated;
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "telegram");
  if (!inbox) return notFound();
  const perInbox = await limitOrResponse(`wh:telegram:${inbox.id}`, { limit: 600, windowSec: 60 });
  if (perInbox) return perInbox;

  const raw = await req.text();
  if (raw.length > MAX_BODY) return new NextResponse("Too large", { status: 413 });
  const v = telegramAdapter.verifyWebhook({ method: "POST", headers: req.headers, rawBody: raw, query: req.nextUrl.searchParams }, inbox);
  if (!v.ok) return new NextResponse("Invalid secret", { status: 401 });

  const events = telegramAdapter.parseInbound(raw);
  if (events.length === 0) return NextResponse.json({ success: true });
  const stats = await processInboundEvents(inbox, events);
  if (stats.failed > 0) return NextResponse.json({ success: false, error: "processing failed" }, { status: 500 });
  if (stats.inserted > 0) await handleStopEvents(inbox, events).catch((e) => console.error("[telegram] stop handling failed", e));
  return NextResponse.json({ success: true });
});
