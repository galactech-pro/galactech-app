import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Fixed-window rate limiter on the `rate_limits` table. ONE atomic upsert-increment per call:
 *   INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count
 * Window boundaries come from the DB clock, so app instances with skewed clocks agree.
 * Fixed windows allow up to 2x burst at a boundary; acceptable for abuse control (not billing).
 * Fails OPEN on DB errors by default (an outage must not lock every user out); pass failClosed for
 * credential-guessing surfaces if you prefer the opposite trade-off.
 */
export interface RateLimitOpts {
  limit: number;
  windowSec: number;
  failClosed?: boolean;
}
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

export async function rateLimit(key: string, opts: RateLimitOpts): Promise<RateLimitResult> {
  const { limit, windowSec } = opts;
  const k = key.slice(0, 200);
  try {
    const rows = await prisma.$queryRaw<{ count: number; ttl: number }[]>(Prisma.sql`
      WITH w AS (SELECT (to_timestamp(floor(extract(epoch from now()) / ${windowSec}::float8) * ${windowSec}::float8) AT TIME ZONE 'UTC') AS ws)
      INSERT INTO rate_limits ("key", window_start, "count")
      SELECT ${k}, w.ws, 1 FROM w
      ON CONFLICT ("key", window_start) DO UPDATE SET "count" = rate_limits."count" + 1
      RETURNING "count"::int AS count,
        ceil(extract(epoch from (window_start + (${windowSec}::float8 * interval '1 second')) - (now() AT TIME ZONE 'UTC')))::int AS ttl
    `);
    const count = rows[0]?.count ?? 1;
    const ttl = Math.max(1, rows[0]?.ttl ?? windowSec);
    if (Math.random() < 0.01) void cleanup();
    return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfter: count <= limit ? 0 : ttl };
  } catch (e) {
    console.error("[rate-limit] store error", (e as Error).message);
    return opts.failClosed ? { ok: false, remaining: 0, retryAfter: windowSec } : { ok: true, remaining: limit, retryAfter: 0 };
  }
}

async function cleanup() {
  await prisma.rate_limits.deleteMany({ where: { window_start: { lt: new Date(Date.now() - 2 * 86_400_000) } } }).catch(() => undefined);
}

/** 429 response in the standard envelope, with Retry-After. */
export function rateLimitResponse(retryAfter = 60): NextResponse {
  return NextResponse.json(
    { success: false, data: null, error: "Too many requests. Please slow down and retry shortly.", code: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfter))) } }
  );
}

/** Convenience: returns a 429 response when over the limit, otherwise null. `const r = await limitOrResponse(...); if (r) return r;` */
export async function limitOrResponse(key: string, opts: RateLimitOpts): Promise<NextResponse | null> {
  const r = await rateLimit(key, opts);
  return r.ok ? null : rateLimitResponse(r.retryAfter);
}

/**
 * Best-effort client IP, in order of trust:
 *  1. CLIENT_IP_HEADER (set it to a header your proxy sets authoritatively, e.g. "cf-connecting-ip").
 *  2. On Vercel (VERCEL=1): x-vercel-forwarded-for / x-real-ip. Vercel overwrites these, so a client cannot spoof them.
 *  3. Elsewhere / local dev: the FIRST hop of x-forwarded-for. ONLY safe behind a proxy that overwrites the header;
 *     if your host appends to a client-supplied value, set CLIENT_IP_HEADER instead.
 */
export function clientIp(req: Request | NextRequest): string {
  const h = req.headers;
  const custom = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  let v = (custom && h.get(custom)) || "";
  if (!v && process.env.VERCEL) v = h.get("x-vercel-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "";
  if (!v) v = h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "";
  const ip = v.trim().slice(0, 64);
  return ip || "unknown";
}
