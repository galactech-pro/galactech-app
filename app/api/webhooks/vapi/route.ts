import { NextResponse, type NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { handleVapiEvent } from "@/lib/channels/voice-events";
import { parseVapiWebhook, verifyVapiSecret } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vapi server messages. Auth: shared secret in a configurable header (VAPI_WEBHOOK_SECRET / VAPI_WEBHOOK_HEADER, see
 * lib/voice/vapi.ts — Vapi's exact scheme is UNVERIFIED). Handling is idempotent and monotonic (lib/channels/voice-events.ts):
 * duplicates and late events can neither regress a call's status nor re-emit call/ended.
 */
export const POST = safe(async (req: NextRequest) => {
  if (!verifyVapiSecret(req)) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Bad request" }, { status: 400 });
  }
  await handleVapiEvent(parseVapiWebhook(body)); // throws -> safe() answers 500 and Vapi retries; claim was released
  return NextResponse.json({ success: true });
});
