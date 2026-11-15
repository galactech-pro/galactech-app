import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { safe } from "@/lib/api";
import { inboxByToken, webhookGate } from "@/lib/channels/adapters/_route";
import { originIsAllowed, publicConfig } from "@/lib/channels/adapters/_webchat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public widget look (title, welcome text, colour) plus whether THIS website may show the chat. Readable from any site because
 * it contains nothing secret; the launcher uses `allowed` to stay hidden on websites that are not in the allow-list.
 */
export const GET = safe<{ token: string }>(async (req: NextRequest, ctx) => {
  const gated = await webhookGate(req, "webchat-config", 120);
  if (gated) return gated;
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "webchat");
  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", Vary: "Origin" };
  if (!inbox) return NextResponse.json({ success: false, error: "Not found" }, { status: 404, headers });
  const origin = req.headers.get("origin");
  const allowed = origin ? originIsAllowed(origin, inbox) : true;
  return NextResponse.json({ success: true, data: { allowed, origin: origin ?? null, config: publicConfig(inbox) } }, { headers });
});
