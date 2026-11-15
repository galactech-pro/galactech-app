import { NextResponse, type NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { instagramAdapter, messengerAdapter } from "@/lib/channels/adapters/meta";
import { webhookGate } from "@/lib/channels/adapters/_route";
import { handleStopEvents } from "@/lib/channels/adapters/_stop";
import { resolveInboxByIdentifier } from "@/lib/channels/inbox";
import { processInboundEvents } from "@/lib/channels/inbound";
import type { InboundEvent } from "@/lib/channels/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1024 * 1024;

/** Meta app-level webhook (one callback URL for Messenger + Instagram). GET = verification handshake. */
export const GET = safe(async (req: NextRequest) => {
  const v = messengerAdapter.verifyWebhook({ method: "GET", headers: req.headers, rawBody: "", query: req.nextUrl.searchParams });
  if (v.ok && v.response) return v.response as NextResponse;
  return new NextResponse("Forbidden", { status: 403 });
});

/**
 * X-Hub-Signature-256 is verified on the RAW body with the app secret (app-level, so there is no per-inbox secret
 * for Meta). The org comes only from the inbox resolved through (channel, entry.id); unknown pages/accounts are dropped.
 */
export const POST = safe(async (req: NextRequest) => {
  const gated = await webhookGate(req, "meta", 1200);
  if (gated) return gated;
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new NextResponse("Too large", { status: 413 });
  const v = messengerAdapter.verifyWebhook({ method: "POST", headers: req.headers, rawBody: raw, query: req.nextUrl.searchParams });
  if (!v.ok) return new NextResponse("Invalid signature", { status: 401 });

  let failed = 0;
  for (const [adapter, channel] of [[messengerAdapter, "messenger"], [instagramAdapter, "instagram"]] as const) {
    const events = adapter.parseInbound(raw);
    const byInbox = new Map<string, InboundEvent[]>();
    for (const ev of events) byInbox.set(ev.inboxIdentifier ?? "", [...(byInbox.get(ev.inboxIdentifier ?? "") ?? []), ev]);
    for (const [identifier, evs] of byInbox) {
      const inbox = await resolveInboxByIdentifier(channel, identifier).catch((e) => {
        console.error("[meta-webhook] inbox lookup failed", e);
        failed += evs.length;
        return null;
      });
      if (!inbox) continue;
      const stats = await processInboundEvents(inbox, evs);
      failed += stats.failed;
      if (stats.failed === 0 && stats.inserted > 0) await handleStopEvents(inbox, evs).catch((e) => console.error("[meta] stop handling failed", e));
    }
  }
  if (failed > 0) return NextResponse.json({ success: false, error: "processing failed" }, { status: 500 });
  return NextResponse.json({ success: true });
});
