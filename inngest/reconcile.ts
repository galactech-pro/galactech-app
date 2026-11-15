import { inngest } from "@/lib/inngest";
import { prisma } from "@/lib/db";

const STUCK_MS = Number(process.env.RECONCILE_STUCK_MINUTES || 10) * 60_000;
const EVENT_RETENTION_MS = Number(process.env.WEBHOOK_EVENT_RETENTION_DAYS || 30) * 24 * 3600_000;

/**
 * Reconcile job (every 10 min):
 *  - outbound messages still 'queued' after >10 min (provider answer lost: error UNKNOWN, or the worker died between
 *    the outbox INSERT and the provider call) -> 'failed' with reason 'unconfirmed'. They are NEVER re-sent automatically
 *    (the provider may already have delivered them); a human can resend. A late delivery callback cannot revive them
 *    (status ranking), which is the safe direction.
 *  - ai_calls stuck 'initiated' with no Vapi id (create-call response lost) -> 'failed'
 *  - webhook_events older than 30 days are deleted (dedup retention; the provider retry window is far shorter)
 */
export const reconcile = inngest.createFunction({ id: "channels-reconcile", retries: 1 }, { cron: "*/10 * * * *" }, async ({ step }) => {
  const cutoff = () => new Date(Date.now() - STUCK_MS);

  const messages = await step.run("stuck-messages", async () => {
    const r = await prisma.messages.updateMany({
      where: { direction: "outbound", status: "queued", idempotency_key: { not: null }, created_at: { lt: cutoff() }, OR: [{ error: null }, { error: "UNKNOWN" }] },
      data: { status: "failed", error: "unconfirmed: the provider response was not received; not retried automatically" },
    });
    return r.count;
  });

  const calls = await step.run("stuck-calls", async () => {
    const r = await prisma.ai_calls.updateMany({
      where: { status: "initiated", vapi_call_id: null, scheduled_at: null, created_at: { lt: cutoff() } },
      data: { status: "failed" },
    });
    return r.count;
  });

  const events = await step.run("expire-webhook-events", async () => {
    const r = await prisma.webhook_events.deleteMany({ where: { received_at: { lt: new Date(Date.now() - EVENT_RETENTION_MS) } } });
    return r.count;
  });

  return { messages_marked_unconfirmed: messages, calls_failed: calls, webhook_events_deleted: events };
});
