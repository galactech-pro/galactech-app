import type { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, type ApiKeySession } from "@/lib/api-key-auth";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";

/**
 * Public v1 API gate: per-IP limit BEFORE key lookup (stops key brute-forcing), API-key auth, then per-key limit.
 * Usage:  const g = await publicGuard(req); if ("response" in g) return g.response;  const auth = g.auth;
 */
export async function publicGuard(req: NextRequest): Promise<{ auth: ApiKeySession } | { response: NextResponse }> {
  const byIp = await limitOrResponse(`pub-ip:${clientIp(req)}`, { limit: 300, windowSec: 60 });
  if (byIp) return { response: byIp };
  const auth = await authenticateApiKey(req); // throws ApiError(401/403) -> handled by safe()
  const byKey = await limitOrResponse(`pub-key:${auth.api_key_id}`, { limit: 60, windowSec: 60 });
  if (byKey) return { response: byKey };
  return { auth };
}
