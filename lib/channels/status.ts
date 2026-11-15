import { prisma, Prisma } from "@/lib/db";
import type { MessageStatus } from "./types";

/** queued < sent < delivered < read; failed outranks everything for the "never regress" guard but may only be applied from queued/sent. */
export const STATUS_RANK: Record<MessageStatus, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * M-09 / monotonic status: ONE conditional UPDATE, so out-of-order and concurrent callbacks are safe.
 *  - sent/delivered/read: applied only if rank(current) < rank(new) (a failed row is rank 4, so it is never revived;
 *    a delivered/read row is never lowered)
 *  - failed: applied only from queued/sent (never overwrites delivered/read)
 * Matches by provider message id (external_id, or the legacy wa_message_id) inside the org. Returns true if updated.
 */
export async function applyMessageStatus(
  orgId: string,
  externalId: string,
  status: MessageStatus,
  opts: { error?: string; at?: Date } = {}
): Promise<boolean> {
  if (status === "queued" || !externalId) return false;
  const at = opts.at ?? new Date();
  const errorText = status === "failed" ? (opts.error ?? "Delivery failed").slice(0, 500) : null;
  const eligible =
    status === "failed"
      ? Prisma.sql`status IN ('queued'::message_status, 'sent'::message_status)`
      : Prisma.sql`(CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END) < ${STATUS_RANK[status]}::int`;
  const n = await prisma.$executeRaw`
    UPDATE messages SET
      status = ${status}::message_status,
      error = COALESCE(${errorText}::text, error),
      sent_at = COALESCE(sent_at, ${at.toISOString()}::timestamp)
    WHERE org_id = ${orgId}::uuid AND direction = 'outbound'
      AND (external_id = ${externalId} OR wa_message_id = ${externalId})
      AND ${eligible}`;
  return n > 0;
}

/** Same idea for ai_calls (H-08). */
export const CALL_TERMINAL = ["completed", "no_answer", "failed"] as const;
