import { prisma, type call_status } from "@/lib/db";
import { claimWebhookEvent, markProcessed, releaseWebhookEvent } from "@/lib/webhook-dedup";
import type { VapiParsed } from "@/lib/voice/vapi";
import { emitEvent } from "./events";
import { CALL_TERMINAL } from "./status";

// Vapi endedReason strings are matched loosely; exact values are UNVERIFIED, so unknown reasons fall through to "completed".
const NO_ANSWER = /(no-answer|busy|did-not-answer|voicemail|customer-did-not-answer)/i;
const FAILED = /(error|failed|invalid|rejected|unavailable)/i;

/** status-update rank guard: a status may only be applied from these predecessors (terminal states are never left). */
const PREDECESSORS: Record<string, call_status[]> = {
  initiated: [],
  ringing: ["initiated"],
  in_progress: ["initiated", "ringing"],
};
const STATUS_MAP: Record<string, call_status> = { queued: "initiated", ringing: "ringing", "in-progress": "in_progress" };

export type VapiOutcome = "ignored" | "duplicate" | "status" | "ended" | "enriched";

/** Locate our ai_calls row: by Vapi call id, else (fallback) by the ai_call_id we put in call metadata, binding the Vapi id. */
async function findCall(p: VapiParsed) {
  // tenant-ok: vapi_call_id is globally unique; org is taken from the row
  const byVapi = await prisma.ai_calls.findUnique({ where: { vapi_call_id: p.vapiCallId } });
  if (byVapi) return byVapi;
  if (!p.aiCallId || !/^[0-9a-f-]{36}$/i.test(p.aiCallId)) return null;
  // tenant-ok: id echoed by Vapi; row only bound if vapi_call_id is still null, org taken from the row
  const byMeta = await prisma.ai_calls.findUnique({ where: { id: p.aiCallId } });
  if (!byMeta || byMeta.vapi_call_id) return null;
  // bind only if still unbound (the create-call response may have been lost: ambiguous send)
  const bound = await prisma.ai_calls.updateMany({ where: { id: byMeta.id, vapi_call_id: null }, data: { vapi_call_id: p.vapiCallId } });
  return bound.count === 1 ? { ...byMeta, vapi_call_id: p.vapiCallId } : null;
}

/**
 * H-08: idempotent Vapi event handling.
 *  - dedup key: vapi_call_id + type + status/endedReason (claimWebhookEvent)
 *  - status-update only moves FORWARD (initiated < ringing < in_progress < terminal) via a conditional UPDATE
 *  - end-of-call-report: the transition to a terminal status is ONE conditional UPDATE (status NOT IN terminal);
 *    only the request that wins it emits 'call/ended' (also event-id deduped). Later duplicates only fill in missing
 *    transcript/summary/recording without changing status.
 */
export async function handleVapiEvent(p: VapiParsed): Promise<VapiOutcome> {
  if (!p.vapiCallId) return "ignored";
  const call = await findCall(p);
  if (!call) return "ignored";

  const eventId = `${p.vapiCallId}:${p.type}:${p.status ?? p.endedReason ?? ""}`;
  if (!(await claimWebhookEvent("vapi", eventId, call.org_id))) return "duplicate";
  try {
    const out = await apply(p, call);
    await markProcessed("vapi", eventId);
    return out;
  } catch (e) {
    await releaseWebhookEvent("vapi", eventId).catch(() => undefined);
    throw e;
  }
}

async function apply(p: VapiParsed, call: { id: string; org_id: string }): Promise<VapiOutcome> {
  if (p.type === "status-update") {
    const st = p.status ? STATUS_MAP[p.status] : undefined;
    if (!st) return "ignored";
    const r = await prisma.ai_calls.updateMany({ where: { id: call.id, status: { in: PREDECESSORS[st] } }, data: { status: st } });
    return r.count === 1 ? "status" : "ignored";
  }

  if (p.type !== "end-of-call-report") return "ignored";

  let status: call_status = "completed";
  if (p.endedReason && NO_ANSWER.test(p.endedReason)) status = "no_answer";
  else if (p.endedReason && FAILED.test(p.endedReason) && !p.transcript) status = "failed";

  const won = await prisma.ai_calls.updateMany({
    where: { id: call.id, status: { notIn: [...CALL_TERMINAL] } },
    data: {
      status,
      ...(p.transcript !== undefined ? { transcript: p.transcript } : {}),
      ...(p.summary !== undefined ? { summary: p.summary } : {}),
      ...(p.durationSeconds !== undefined ? { duration_seconds: p.durationSeconds } : {}),
      ...(p.recordingUrl !== undefined ? { recording_url: p.recordingUrl } : {}),
      ...(p.costInr !== undefined ? { cost_inr: p.costInr } : {}),
    },
  });
  if (won.count === 1) {
    await emitEvent("call/ended", { org_id: call.org_id, ai_call_id: call.id }, `call-ended-${call.id}`);
    return "ended";
  }

  // Already terminal: never touch status, never re-emit; only fill gaps.
  await prisma.$executeRaw`
    UPDATE ai_calls SET
      transcript = COALESCE(transcript, ${p.transcript ?? null}::text),
      summary = COALESCE(summary, ${p.summary ?? null}::text),
      recording_url = COALESCE(recording_url, ${p.recordingUrl ?? null}::text),
      duration_seconds = COALESCE(duration_seconds, ${p.durationSeconds ?? null}::int)
    WHERE id = ${call.id}::uuid`;
  return "enriched";
}
