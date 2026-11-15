import { NextResponse, type NextRequest } from "next/server";
import type { InboxCtx } from "../types";

/** Normalise an origin to "scheme://host[:port]" (lowercase) or null. Only http(s) origins are accepted. */
export function normalizeOrigin(o: string): string | null {
  try {
    const u = new URL(o.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function allowedOrigins(inbox: InboxCtx): string[] {
  const v = inbox.config.allowed_origins;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => normalizeOrigin(x)).filter((x): x is string => !!x) : [];
}

/**
 * Strict CORS: the request Origin must be EXACTLY in the inbox's allow-list (empty list = nobody). A missing Origin is
 * rejected too. This stops other sites from embedding the endpoint in a browser; it is not authentication (non-browser
 * clients can forge Origin), so rate limits and size limits still apply.
 */
export function originAllowed(req: NextRequest, inbox: InboxCtx): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  const n = normalizeOrigin(origin);
  return n && allowedOrigins(inbox).includes(n) ? origin : null;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: "Origin", "Cache-Control": "no-store" };
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

export function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...corsHeaders(origin), ...extra } });
}

/** Public widget settings returned to the browser (never secrets). */
export function publicConfig(inbox: InboxCtx) {
  const s = (k: string, max: number) => (typeof inbox.config[k] === "string" ? (inbox.config[k] as string).slice(0, max) : "");
  const color = s("color", 9);
  return {
    title: s("title", 60) || "Chat with us",
    welcome: s("welcome", 200) || "Hi! How can we help?",
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#2563eb",
    collect: inbox.config.collect_details === true,
  };
}
