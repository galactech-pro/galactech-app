import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ComplianceError, assertCanContact } from "@/lib/compliance";
import { sendOutbound } from "@/lib/channels/outbound";
import { toApiError } from "@/lib/channels/errors";
import { buildVoiceGuardrails, ensureDisclosure, generateCallScript, getVoiceConfig } from "@/lib/ai";

export { listVoices, parseVapiWebhook, verifyVapiSecret, type VapiParsed, type VoiceOption } from "./vapi";

const BUCKET_MS = 30 * 60 * 1000;

/**
 * Place an AI call through the shared outbound pipeline (compliance incl. calling window, atomic ai_calls limit,
 * outbox row, no blind re-dial).
 *
 * Idempotency: pass opts.idempotencyKey from a stable business key (campaign: campaignKey(campaignId, contactId)).
 * When omitted the key is (org, contact, attempt, 30-minute bucket) so an Inngest step retry of the same dial collapses
 * onto the first attempt; interactive callers (POST /api/voice/call) pass a random key so each click is a new call.
 * If a call for the key already exists, nothing is dialled and the existing call is returned.
 * A call whose provider response was lost stays "unconfirmed" (see inngest/reconcile.ts) and is never re-dialled automatically.
 */
export async function initiateCall(
  orgId: string,
  contactId: string,
  customScript?: string,
  opts: { attempt?: number; idempotencyKey?: string; campaignId?: string; purpose?: "marketing" | "service"; automated?: boolean } = {}
): Promise<{ aiCallId: string; vapiCallId: string }> {
  if (!process.env.VAPI_API_KEY || !process.env.VAPI_PHONE_NUMBER_ID) throw new ApiError(400, "Voice calling is not configured");

  const [org, contact] = await Promise.all([
    prisma.organisations.findUnique({ where: { id: orgId } }),
    prisma.contacts.findFirst({ where: { id: contactId, org_id: orgId } }),
  ]);
  if (!org) throw new ApiError(404, "Organisation not found");
  if (!contact) throw new ApiError(404, "Contact not found");

  const attempt = opts.attempt ?? 1;
  const purpose = opts.purpose ?? (opts.campaignId ? "marketing" : "service");
  const key = opts.idempotencyKey ?? `voice:${contactId}:a${attempt}:${Math.floor(Date.now() / BUCKET_MS)}`;

  // Cheap pre-checks before paying for an LLM script (the pipeline re-checks authoritatively).
  try {
    await assertCanContact(orgId, contactId, "voice", { purpose, automated: opts.automated });
  } catch (e) {
    if (e instanceof ComplianceError) throw toApiError(e);
    throw e;
  }

  let script: string;
  let firstMessage: string;
  if (customScript?.trim()) {
    const cfg = getVoiceConfig(org.name);
    script = `${customScript.trim()}

${buildVoiceGuardrails(cfg)}`;
    firstMessage = ensureDisclosure(`Hello, am I speaking with ${contact.full_name.split(/\s+/)[0]}?`, cfg);
  } else {
    const g = await generateCallScript(contact, org);
    script = `${g.script}\n\nLikely objections and replies:\n${g.objections.join("\n")}`;
    firstMessage = g.first_message;
  }

  try {
    const r = await sendOutbound({
      orgId,
      contactId,
      channel: "voice",
      content: { kind: "voice_call", script, firstMessage, attempt },
      purpose,
      automated: opts.automated,
      campaignId: opts.campaignId ?? null,
      idempotencyKey: key,
    });
    if (r.state === "unknown") throw new ApiError(502, "The call request could not be confirmed. It will not be retried automatically.", "UNCONFIRMED");
    if (r.message.status === "failed") throw new ApiError(502, `Call failed to start: ${r.message.error ?? "unknown error"}`);
    const vapiCallId = r.message.external_id ?? "";
    // tenant-ok: vapi call id returned by our own call
    const call = vapiCallId ? await prisma.ai_calls.findUnique({ where: { vapi_call_id: vapiCallId }, select: { id: true } }) : null;
    if (!call) throw new ApiError(409, "A call for this request already exists", "DUPLICATE");
    return { aiCallId: call.id, vapiCallId };
  } catch (e) {
    throw toApiError(e, "Call");
  }
}
