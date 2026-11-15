import { NextResponse, type NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { twilioSmsAdapter } from "@/lib/channels/adapters/sms-twilio";
import { inboxByToken, notFound, webhookGate } from "@/lib/channels/adapters/_route";
import { processInboundEvents } from "@/lib/channels/inbound";
import { limitOrResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Twilio inbound SMS webhook (form-encoded). X-Twilio-Signature verified with the per-inbox auth token. STOP is handled by processInboundEvents (sms). */
export const POST = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const gated = await webhookGate(req, "sms");
  if (gated) return gated;
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "sms");
  if (!inbox) return notFound();
  const perInbox = await limitOrResponse(`wh:sms:${inbox.id}`, { limit: 600, windowSec: 60 });
  if (perInbox) return perInbox;

  const raw = await req.text();
  if (raw.length > 64 * 1024) return new NextResponse("Too large", { status: 413 });
  const v = twilioSmsAdapter.verifyWebhook({ method: "POST", headers: req.headers, rawBody: raw, query: new URLSearchParams() }, inbox);
  if (!v.ok) return new NextResponse("Invalid signature", { status: 401 });

  const events = twilioSmsAdapter.parseInbound(raw);
  const stats = await processInboundEvents(inbox, events);
  if (stats.failed > 0) return NextResponse.json({ success: false, error: "processing failed" }, { status: 500 });
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "content-type": "text/xml" } });
});
