import { z } from "zod";
import { fail, ok, parseBody, safe } from "@/lib/api";
import { publicGuard } from "@/app/api/public/_guard";
import { applyContactDetails } from "@/lib/channels/adapters/_capture";
import { ensureApiInbox } from "@/lib/channels/adapters/_connect";
import { processInboundEvents } from "@/lib/channels/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  /** The sender's identifier in YOUR system (user id, email, anything stable). One contact per source_id. */
  source_id: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(10_000),
  /** Idempotency key: re-posting the same external_id is a no-op. Recommended. */
  external_id: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(32).optional(),
  /** ISO timestamp of the original message (defaults to now). */
  sent_at: z.string().datetime().optional(),
});

/**
 * POST /api/public/v1/messages (Authorization: Bearer or_live_..., Pro plan, rate limited by publicGuard).
 * Ingests an inbound message from an external system into a conversation on the org's "api" inbox, through the shared
 * inbound pipeline (dedupe, contact + conversation creation, automations). Inbound only; no outbound callback yet.
 */
export const POST = safe(async (req) => {
  const g = await publicGuard(req);
  if ("response" in g) return g.response;
  const b = await parseBody(req, Body);
  const inbox = await ensureApiInbox(g.auth.org_id);
  const externalId = b.external_id ? `ext:${b.external_id}` : `gen:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
  const stats = await processInboundEvents(inbox, [
    { kind: "message", externalId, sourceId: b.source_id, contactName: b.name, contactEmail: b.email, content: b.content, contentType: "text", sentAt: b.sent_at ? new Date(b.sent_at) : undefined },
  ]);
  if (stats.failed > 0) return fail("Could not process the message, please retry", 500);
  if (stats.inserted > 0) await applyContactDetails(inbox.org_id, inbox.id, b.source_id, b).catch((e) => console.error("[api-channel] contact details failed", e));
  return ok({ accepted: true, duplicate: stats.inserted === 0 && stats.duplicates > 0 }, stats.inserted > 0 ? 201 : 200);
});
