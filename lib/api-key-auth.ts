import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma, type plan } from "@/lib/db";
import { ApiError } from "@/lib/api";

export interface ApiKeySession {
  org_id: string;
  plan: plan;
  api_key_id: string;
}

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Returns { key (shown once), hash, prefix }. */
export function generateApiKey() {
  const key = `or_live_${randomBytes(24).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}

/**
 * Authenticates `Authorization: Bearer or_live_…` (or `X-API-Key`). Throws ApiError(401) on failure,
 * 403 when the org is no longer on Pro. Bumps last_used_at (non-blocking).
 */
export async function authenticateApiKey(req: NextRequest | Request): Promise<ApiKeySession> {
  const h = req.headers.get("authorization");
  const key = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : req.headers.get("x-api-key")?.trim();
  if (!key || !key.startsWith("or_live_")) throw new ApiError(401, "Missing or invalid API key");
  // tenant-ok: the key hash IS the tenant definition here; org_id is derived from this row
  const row = await prisma.api_keys.findUnique({
    where: { key_hash: hashApiKey(key) },
    include: { org: { select: { plan: true } } },
  });
  if (!row || (row.expires_at && row.expires_at < new Date())) throw new ApiError(401, "Invalid or expired API key");
  if (row.org.plan !== "pro") throw new ApiError(403, "API access requires the Pro plan");
  void prisma.api_keys.update({ where: { id: row.id, org_id: row.org_id }, data: { last_used_at: new Date() } }).catch(() => undefined);
  return { org_id: row.org_id, plan: row.org.plan, api_key_id: row.id };
}
