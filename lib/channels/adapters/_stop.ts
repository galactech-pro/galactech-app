import { prisma } from "@/lib/db";
import { applyStopKeyword, isStopKeyword } from "@/lib/compliance";
import { sendOutbound } from "../outbound";
import type { InboundEvent, InboxCtx } from "../types";

/**
 * processInboundEvents only runs the STOP flow for whatsapp/sms. For the other chat channels the route calls this
 * after a successful ingest: '/stop' (Telegram command form) and the configured keywords -> confirmation reply
 * (service purpose, sent BEFORE the opt-out flags) then applyStopKeyword. Idempotent: re-applying a revocation
 * only appends a ledger row.
 */
export async function handleStopEvents(inbox: InboxCtx, events: InboundEvent[]): Promise<void> {
  for (const ev of events) {
    if (ev.kind !== "message" || !ev.sourceId || !ev.content) continue;
    const text = ev.content.trim().replace(/^\/(stop|unsubscribe)(@\w+)?/i, "$1");
    if (!isStopKeyword(text)) continue;
    const ci = await prisma.contact_inboxes.findUnique({ where: { inbox_id_source_id: { inbox_id: inbox.id, source_id: ev.sourceId } }, select: { contact_id: true } });
    if (!ci) continue;
    try {
      await sendOutbound({
        orgId: inbox.org_id,
        contactId: ci.contact_id,
        channel: inbox.channel,
        inboxId: inbox.id,
        content: { kind: "text", text: process.env.STOP_CONFIRMATION_TEXT || "You have been unsubscribed and will not receive further messages from us." },
        purpose: "service",
        idempotencyKey: `stop-confirm:${inbox.id}:${ev.externalId}`,
      });
    } catch (e) {
      console.warn("[stop] confirmation not sent", e instanceof Error ? e.message : e);
    }
    await applyStopKeyword(inbox.org_id, ci.contact_id, inbox.channel, text);
  }
}
