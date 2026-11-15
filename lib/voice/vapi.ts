import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { ApiError } from "@/lib/api";
import { ChannelError } from "@/lib/channels/types";

export const VAPI = "https://api.vapi.ai";
const TIMEOUT_MS = Number(process.env.VAPI_HTTP_TIMEOUT_MS) || 20_000;

export interface VapiParsed {
  vapiCallId: string;
  /** Our ai_calls.id echoed back via call.metadata (UNVERIFIED that Vapi includes metadata in webhooks; used only as a fallback). */
  aiCallId?: string;
  type: string;
  status?: string;
  transcript?: string;
  summary?: string;
  durationSeconds?: number;
  recordingUrl?: string;
  costInr?: number;
  endedReason?: string;
}

export const DEFAULT_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", gender: "female" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", gender: "female" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", gender: "male" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni", gender: "male" },
];

/**
 * Webhook auth. Vapi's exact server-URL auth scheme is UNVERIFIED in our research, so the header NAME is configurable:
 *   VAPI_WEBHOOK_SECRET        shared secret (required; without it every webhook is rejected)
 *   VAPI_WEBHOOK_HEADER        header carrying it (default "x-vapi-secret")
 * "Authorization: Bearer <secret>" is also accepted as a fallback. Comparison is constant-time.
 */
export function verifyVapiSecret(req: Request): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = (process.env.VAPI_WEBHOOK_HEADER || "x-vapi-secret").toLowerCase();
  const got = req.headers.get(header) ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const USD_INR = () => Number(process.env.USD_INR_RATE) || 84;

export function parseVapiWebhook(body: unknown): VapiParsed {
  const root = (body ?? {}) as Record<string, unknown>;
  const msg = ((root.message as Record<string, unknown> | undefined) ?? root) as Record<string, unknown>;
  const call = (msg.call as Record<string, unknown> | undefined) ?? {};
  const artifact = (msg.artifact as Record<string, unknown> | undefined) ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

  let duration = num(msg.durationSeconds);
  if (duration === undefined) {
    const ms = num(msg.durationMs);
    if (ms !== undefined) duration = ms / 1000;
  }
  if (duration === undefined) {
    const s = str(call.startedAt ?? msg.startedAt);
    const e = str(call.endedAt ?? msg.endedAt);
    if (s && e) duration = Math.max(0, (Date.parse(e) - Date.parse(s)) / 1000);
  }
  const costUsd = num(msg.cost) ?? num(call.cost);
  const analysis = (msg.analysis as Record<string, unknown> | undefined) ?? {};
  const metadata = (call.metadata as Record<string, unknown> | undefined) ?? {};

  return {
    vapiCallId: str(call.id) ?? str(msg.callId) ?? "",
    aiCallId: str(metadata.ai_call_id),
    type: str(msg.type) ?? "unknown",
    status: str(msg.status),
    transcript: str(artifact.transcript) ?? str(msg.transcript),
    summary: str(analysis.summary) ?? str(msg.summary),
    durationSeconds: duration === undefined ? undefined : Math.round(duration),
    recordingUrl: str(artifact.recordingUrl) ?? str(msg.recordingUrl),
    costInr: costUsd === undefined ? undefined : Math.round(costUsd * USD_INR() * 100) / 100,
    endedReason: str(msg.endedReason) ?? str(call.endedReason),
  };
}

export interface PlaceCallInput {
  orgId: string;
  contactId: string;
  to: string;
  script: string;
  firstMessage: string;
  attempt: number;
}

/**
 * Creates the ai_calls row and POSTs /call to Vapi - exactly once (called only from the outbound pipeline, which
 * guarantees one invocation per idempotency key). Network error / 5xx -> ambiguous (the call may have been placed):
 * the ai_calls row stays 'initiated' and is resolved by the reconcile job; it is NEVER re-dialled automatically.
 */
export async function placeVapiCall(input: PlaceCallInput): Promise<{ aiCallId: string; vapiCallId: string }> {
  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!apiKey || !phoneNumberId) throw new ApiError(400, "Voice calling is not configured");

  const [org, contact] = await Promise.all([
    prisma.organisations.findUnique({ where: { id: input.orgId }, select: { elevenlabs_voice_id: true } }),
    prisma.contacts.findFirst({ where: { id: input.contactId, org_id: input.orgId }, select: { full_name: true } }),
  ]);
  if (!org || !contact) throw new ApiError(404, "Contact not found");

  const row = await prisma.ai_calls.create({
    data: { org_id: input.orgId, contact_id: input.contactId, to_number: input.to, status: "initiated", attempt: input.attempt },
  });
  const voiceId = org.elevenlabs_voice_id || process.env.ELEVENLABS_DEFAULT_VOICE_ID || DEFAULT_VOICES[0].id;
  const webhookSecret = process.env.VAPI_WEBHOOK_SECRET;

  let res: Response;
  try {
    res = await fetch(`${VAPI}/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        phoneNumberId,
        customer: { number: input.to, name: contact.full_name },
        assistant: {
          firstMessage: input.firstMessage,
          model: {
            provider: "google",
            model: process.env.VAPI_GEMINI_MODEL || "gemini-2.0-flash",
            temperature: 0.7,
            messages: [{ role: "system", content: input.script }],
          },
          voice: { provider: "11labs", voiceId },
          transcriber: { provider: "deepgram", model: "nova-2", language: "en-IN" },
          maxDurationSeconds: 600,
          endCallPhrases: ["goodbye", "not interested", "remove me from your list"],
          server: { url: `${appUrl()}/api/webhooks/vapi`, ...(webhookSecret ? { secret: webhookSecret } : {}) },
          serverMessages: ["end-of-call-report", "status-update"],
        },
        metadata: { ai_call_id: row.id, org_id: input.orgId, contact_id: input.contactId },
      }),
    });
  } catch {
    // Ambiguous: leave ai_calls 'initiated'; reconcile decides.
    throw new ChannelError("NETWORK", "No response from the voice provider", { ambiguous: true });
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: unknown };
  if (!res.ok || !json.id) {
    const m = Array.isArray(json.message) ? json.message.join(", ") : String(json.message ?? res.status);
    if (res.status >= 500 || res.ok) throw new ChannelError(String(res.status), `Call failed to start: ${m}`, { ambiguous: true, httpStatus: res.status });
    // tenant-ok: row created in this call for input.orgId
    await prisma.ai_calls.update({ where: { id: row.id }, data: { status: "failed" } }).catch(() => undefined);
    throw new ChannelError(String(res.status), `Call failed to start: ${m}`, { httpStatus: res.status });
  }
  // tenant-ok: row created in this call for input.orgId
  await prisma.ai_calls.update({ where: { id: row.id }, data: { vapi_call_id: json.id, status: "ringing" } });
  return { aiCallId: row.id, vapiCallId: json.id };
}

export interface VoiceOption {
  id: string;
  name: string;
  gender: string;
  preview_url?: string;
  accent?: string;
}

/** Indian-English voices first (ElevenLabs library labels), falling back to premade voices. */
export async function listVoices(): Promise<VoiceOption[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return DEFAULT_VOICES;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (!res.ok) return DEFAULT_VOICES;
    const json = (await res.json()) as {
      voices?: { voice_id: string; name: string; preview_url?: string; labels?: Record<string, string> }[];
    };
    const all: VoiceOption[] = (json.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender ?? "unknown",
      preview_url: v.preview_url,
      accent: v.labels?.accent,
    }));
    const indian = (v: VoiceOption) => /indian|india|hindi/i.test(`${v.accent ?? ""} ${v.name}`);
    const sorted = [...all.filter(indian), ...all.filter((v) => !indian(v))];
    return sorted.length ? sorted : DEFAULT_VOICES;
  } catch {
    return DEFAULT_VOICES;
  }
}
