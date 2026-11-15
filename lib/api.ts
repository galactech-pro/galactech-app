import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodTypeAny } from "zod";
import { getSession, hasRole, type Session } from "@/lib/auth";
import type { user_role } from "@/lib/db";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json<ApiResponse<T>>({ success: true, data, error: null }, { status });
}

export function fail(error: string, status = 400, code?: string) {
  return NextResponse.json<ApiResponse<null> & { code?: string }>(
    { success: false, data: null, error, ...(code ? { code } : {}) },
    { status }
  );
}

interface Options {
  /** Minimum role required. Default "viewer" (any signed-in user). Mutations should pass "member". */
  role?: user_role;
  /** Optional per-user limiter for this handler (keyed by route path + user). Not applied by default. */
  rateLimit?: { limit: number; windowSec: number };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth for cookie-authenticated mutations: browsers always send `Origin` on cross-site POST/PUT/
 * PATCH/DELETE, so a present Origin must match this host (or NEXT_PUBLIC_APP_URL). A missing Origin (non-browser
 * client, same-origin legacy) is allowed; SameSite=Lax cookies remain the primary control.
 */
export function isCrossOriginMutation(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  const allowed = new Set<string>();
  const h = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (h) allowed.add(h);
  try {
    if (process.env.NEXT_PUBLIC_APP_URL) allowed.add(new URL(process.env.NEXT_PUBLIC_APP_URL).host);
  } catch {
    /* ignore malformed env */
  }
  return !allowed.has(host);
}

// Next 15: dynamic route params are a Promise - `const { id } = await ctx.params`
type Ctx<P> = { params: Promise<P> };

/**
 * Wraps a Route Handler: auth → role check → try/catch → { success, data, error }.
 * Usage:
 *   export const GET = withAuth(async (req, session) => ok(await ...));
 *   export const PATCH = withAuth(async (req, session, ctx) => ..., { role: "member" });
 */
export function withAuth<P = Record<string, string>>(
  handler: (req: NextRequest, session: Session, ctx: Ctx<P>) => Promise<NextResponse>,
  opts: Options = {}
) {
  return async (req: NextRequest, ctx: Ctx<P>): Promise<NextResponse> => {
    try {
      if (isCrossOriginMutation(req)) return fail("Cross-origin request blocked", 403);
      const session = await getSession();
      if (!session) return fail("Unauthorized", 401);
      if (opts.role && !hasRole(session, opts.role)) return fail("Forbidden", 403);
      if (opts.rateLimit) {
        const { limitOrResponse } = await import("@/lib/rate-limit");
        const limited = await limitOrResponse(`api:${req.nextUrl.pathname}:${session.user.id}`, opts.rateLimit);
        if (limited) return limited;
      }
      return await handler(req, session, ctx);
    } catch (e) {
      return handleError(e);
    }
  };
}

/** For public/webhook routes that do their own verification. */
export function safe<P = Record<string, string>>(
  handler: (req: NextRequest, ctx: Ctx<P>) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: Ctx<P>): Promise<NextResponse> => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      return handleError(e);
    }
  };
}

export function handleError(e: unknown): NextResponse {
  if (e instanceof ApiError) return fail(e.message, e.status, e.code);
  if (e instanceof ZodError) return fail(e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 422);
  // PlanLimitError is duck-typed so this file has no import cycle with limits.ts
  if (e && typeof e === "object" && (e as { name?: string }).name === "PlanLimitError") {
    return fail((e as Error).message, 402, "PLAN_LIMIT");
  }
  console.error("[api] unhandled", e); // TODO: Sentry.captureException when SENTRY_DSN set
  return fail("Internal server error", 500);
}

export async function parseBody<S extends ZodTypeAny>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  return schema.parse(json);
}

export function parseQuery<S extends ZodTypeAny>(req: NextRequest, schema: S): z.infer<S> {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams));
}
