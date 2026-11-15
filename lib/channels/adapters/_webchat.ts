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
const bareOrigin = (o: string) => o.replace("://www.", "://"); // example.com and www.example.com are the same site

/** Is this browser Origin allowed to use this chat? Our own hosted page is always allowed; customer sites must be in the allow-list. */
export function originIsAllowed(origin: string, inbox: InboxCtx): boolean {
  const n = normalizeOrigin(origin);
  if (!n) return false;
  return ownOrigins().includes(n) || allowedOrigins(inbox).some((a) => bareOrigin(a) === bareOrigin(n));
}

/** Strict CORS for the message and poll endpoints: the Origin must be allowed; a missing Origin is only accepted for same-origin GETs. */
export function originAllowed(req: NextRequest, inbox: InboxCtx): string | null {
  const origin = req.headers.get("origin");
  if (!origin) {
    return req.headers.get("sec-fetch-site") === "same-origin" ? ownOrigins()[0] ?? null : null;
  }
  return originIsAllowed(origin, inbox) ? origin : null;
}

/** CSP frame-ancestors value: only the allowed websites (both www and bare) and our own domain may embed the chat frame. */
export function frameAncestors(inbox: InboxCtx): string {
  const set = new Set<string>(ownOrigins());
  for (const o of allowedOrigins(inbox)) {
    set.add(o);
    set.add(o.includes("://www.") ? o.replace("://www.", "://") : o.replace("://", "://www."));
  }
  return [...set].join(" ");
}

function ownOrigins(): string[] {
  const out = new Set<string>();
  for (const v of [process.env.NEXT_PUBLIC_APP_URL, "https://app.galactech.pro"]) {
    const n = v ? normalizeOrigin(v) : null;
    if (n) out.add(n);
  }
  return [...out];
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
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#00C16A",
    collect: inbox.config.collect_details === true,
  };
}
