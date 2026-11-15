import { NextResponse, type NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { parseTwilioStatus, twilioSmsAdapter } from "@/lib/channels/adapters/sms-twilio";
import { inboxByToken, notFound, webhookGate } from "@/lib/channels/adapters/_route";
import { processInboundEvents } from "@/lib/channels/inbound";
import { limitOrResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Twilio status callback. Out-of-order safe: ingestStatus -> applyMessageStatus (monotonic, single conditional UPDATE). */
export const POST = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const gated = await webhookGate(req, "sms-status");
  if (gated) return gated;
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "sms");
  if (!inbox) return notFound();
  const perInbox = await limitOrResponse(`wh:sms-status:${inbox.id}`, { limit: 1200, windowSec: 60 });
  if (perInbox) return perInbox;

  const raw = await req.text();
  if (raw.length > 64 * 1024) return new NextResponse("Too large", { status: 413 });
  const v = twilioSmsAdapter.verifyWebhook({ method: "POST", headers: req.headers, rawBody: raw, query: new URLSearchParams({ kind: "status" }) }, inbox);
  if (!v.ok) return new NextResponse("Invalid signature", { status: 401 });

  const stats = await processInboundEvents(inbox, parseTwilioStatus(raw));
  if (stats.failed > 0) return NextResponse.json({ success: false, error: "processing failed" }, { status: 500 });
  return new NextResponse(null, { status: 204 });
});
