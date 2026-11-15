import type { NextRequest } from "next/server";
import { inboxByToken } from "@/lib/channels/adapters/_route";
import { frameAncestors } from "@/lib/channels/adapters/_webchat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The chat frame placed on customer websites by /webchat.js. It runs on OUR origin, so the browser never blocks its calls to the
 * API (no cross-site requests). Only the websites in the channel's allow-list may embed it (CSP frame-ancestors).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const inbox = await inboxByToken(token, "webchat");
  if (!inbox) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Chat</title><style>html,body{margin:0;height:100%;background:#0b0b0b}</style></head><body><script src="/webchat.js" data-token="${token}" data-mode="page" data-embed="1"></script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors(inbox)}`,
    },
  });
}
