import { NextResponse, type NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { whatsappCloudAdapter } from "@/lib/channels/adapters/whatsapp";
import { resolveInboxByIdentifier } from "@/lib/channels/inbox";
import { processInboundEvents } from "@/lib/channels/inbound";
import type { InboundEvent } from "@/lib/channels/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta webhook verification handshake (constant-time token compare lives in the adapter). */
export const GET = safe(async (req: NextRequest) => {
  const v = whatsappCloudAdapter.verifyWebhook({ method: "GET", headers: req.headers, rawBody: "", query: req.nextUrl.searchParams });
  if (v.ok && v.response) return v.response as NextResponse;
  return new NextResponse("Forbidden", { status: 403 });
});

/**
 * Signature is verified on the RAW body first. The receiving org is never taken from the payload: each event's
 * metadata.phone_number_id is resolved to an inbox (channel+identifier unique), the org comes from that inbox row.
 * Events for unknown numbers are dropped. 200 only when every event was processed (or safely deduplicated);
 * otherwise 500 so Meta retries (events already processed are skipped by the webhook_events claim).
 */
export const POST = safe(async (req: NextRequest) => {
  const raw = await req.text();
  const v = whatsappCloudAdapter.verifyWebhook({ method: "POST", headers: req.headers, rawBody: raw, query: req.nextUrl.searchParams });
  if (!v.ok) return new NextResponse("Invalid signature", { status: 401 });

  const events = whatsappCloudAdapter.parseInbound(raw);
  const byInbox = new Map<string, InboundEvent[]>();
  for (const ev of events) {
    const id = ev.inboxIdentifier ?? "";
    byInbox.set(id, [...(byInbox.get(id) ?? []), ev]);
  }

  let failed = 0;
  for (const [identifier, evs] of byInbox) {
    const inbox = await resolveInboxByIdentifier("whatsapp", identifier).catch((e) => {
      console.error("[wa-webhook] inbox lookup failed", e);
      failed += evs.length;
      return null;
    });
    if (!inbox) continue; // unknown number: not ours, drop
    failed += (await processInboundEvents(inbox, evs)).failed;
  }
  if (failed > 0) return NextResponse.json({ success: false, error: "processing failed" }, { status: 500 });
  return NextResponse.json({ success: true });
});
