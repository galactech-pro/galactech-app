import { inngest, type Events } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { PlanLimitError } from "@/lib/limits";
import { canDialNow } from "@/lib/compliance";
import { initiateCall } from "@/lib/voice";

/** WF-006 lives in ./wf-006 (agent A, H-09); re-exported so inngest/functions.ts is unchanged. */
export { wf006CallPostProcessing } from "./wf-006";

const LEASE_MS = 15 * 60_000;
const MAX_AGE_MS = 24 * 3600_000;

/** Call retry: no_answer -> +2h, -> next day, max 3 attempts. Respects the calling window (sleeps until it opens). */
export const callRetry = inngest.createFunction(
  { id: "call-retry", retries: 2 },
  { event: "call/ended" },
  async ({ event, step }) => {
    const d = event.data as Events["call/ended"];
    const call = await step.run("load", async () => {
      const c = await prisma.ai_calls.findFirst({ where: { id: d.ai_call_id, org_id: d.org_id } });
      return c ? { status: c.status, attempt: c.attempt, contact_id: c.contact_id } : null;
    });
    if (!call || call.status !== "no_answer" || call.attempt >= 3) return { skipped: true };

    await step.sleep("backoff", call.attempt === 1 ? "2h" : "1d");

    // Deterministic: the gate result is a memoised step output; at most two waits for the calling window.
    for (let k = 0; k < 2; k++) {
      const gate = await step.run(`gate-${k}`, async () => {
        const g = await canDialNow(d.org_id, call.contact_id);
        return { allowed: g.allowed, code: g.code ?? null, retryAt: g.retryAt ? g.retryAt.toISOString() : null };
      });
      if (gate.allowed) break;
      if (gate.code !== "OUTSIDE_CALL_HOURS" || !gate.retryAt) return { skipped: gate.code ?? "not allowed" };
      await step.sleepUntil(`window-${k}`, new Date(gate.retryAt));
    }

    return step.run("retry", async () => {
      const replied = await prisma.messages.count({
        where: { org_id: d.org_id, contact_id: call.contact_id, direction: "inbound", created_at: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
      });
      if (replied > 0) return "contact replied";
      try {
        // stable key: a step retry after a lost response can never dial twice
        await initiateCall(d.org_id, call.contact_id, undefined, {
          attempt: call.attempt + 1,
          idempotencyKey: `call-retry:${d.ai_call_id}:${call.attempt + 1}`,
          purpose: "marketing",
          automated: true,
        });
        return "retried";
      } catch (e) {
        if (e instanceof ApiError || e instanceof PlanLimitError) return e.message;
        throw e;
      }
    });
  }
);

/**
 * Dispatches calls scheduled via POST /api/voice/call (placeholder ai_calls rows with scheduled_at). Every 5 min.
 * M-17: a placeholder is never marked failed up-front. It is LEASED by pushing scheduled_at forward 15 minutes; outside
 * the calling window it is rescheduled to the next window; transient failures simply become due again after the lease;
 * only permanent refusals (compliance, plan limit, not configured) or a placeholder older than 24h end as 'failed'.
 */
export const scheduledCalls = inngest.createFunction(
  { id: "scheduled-calls-dispatch", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const due = await step.run("find-due", async () => {
      return prisma.ai_calls.findMany({
        where: { status: "initiated", vapi_call_id: null, scheduled_at: { lte: new Date() } },
        orderBy: { scheduled_at: "asc" },
        take: 25,
        select: { id: true, org_id: true, contact_id: true, attempt: true, created_at: true },
      });
    });
    let dispatched = 0;
    for (const row of due) {
      const ok = await step.run(`dispatch-${row.id}`, async () => {
        const lease = await prisma.ai_calls.updateMany({
          where: { id: row.id, org_id: row.org_id, vapi_call_id: null, status: "initiated", scheduled_at: { lte: new Date() } },
          data: { scheduled_at: new Date(Date.now() + LEASE_MS) },
        });
        if (lease.count === 0) return false; // another run owns it
        const gate = await canDialNow(row.org_id, row.contact_id, { purpose: "service", automated: false });
        if (!gate.allowed) {
          if (gate.code === "OUTSIDE_CALL_HOURS" && gate.retryAt) {
            await prisma.ai_calls.updateMany({ where: { id: row.id, org_id: row.org_id, vapi_call_id: null }, data: { scheduled_at: gate.retryAt } });
          } else {
            await prisma.ai_calls.updateMany({ where: { id: row.id, org_id: row.org_id, vapi_call_id: null }, data: { status: "failed" } });
          }
          return false;
        }
        try {
          await initiateCall(row.org_id, row.contact_id, undefined, { attempt: row.attempt, idempotencyKey: `scheduled-call:${row.id}`, purpose: "service", automated: false });
          await prisma.ai_calls.deleteMany({ where: { id: row.id, org_id: row.org_id, vapi_call_id: null } }); // replaced by the real call row
          return true;
        } catch (e) {
          const permanent = e instanceof PlanLimitError || (e instanceof ApiError && e.status < 500) || Date.now() - new Date(row.created_at).getTime() > MAX_AGE_MS;
          if (permanent) await prisma.ai_calls.updateMany({ where: { id: row.id, org_id: row.org_id, vapi_call_id: null }, data: { status: "failed" } });
          else if (!(e instanceof ApiError)) console.error("[scheduled-calls]", e);
          return false; // transient: stays 'initiated' and becomes due again when the lease expires
        }
      });
      if (ok) dispatched++;
    }
    return { due: due.length, dispatched };
  }
);
