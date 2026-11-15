import { z } from "zod";
import { withAuth, ok, fail, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { generateApiKey } from "@/lib/api-key-auth";
import { limitOrResponse } from "@/lib/rate-limit";

const proOnly = (plan: string) => (plan !== "pro" ? fail("API keys require the Pro plan", 402, "PLAN_LIMIT") : null);

export const GET = withAuth(
  async (_req, session) => {
    const blocked = proOnly(session.plan);
    if (blocked) return blocked;
    const keys = await prisma.api_keys.findMany({
      where: { org_id: session.org_id },
      select: { id: true, name: true, key_prefix: true, last_used_at: true, expires_at: true, created_at: true },
      orderBy: { created_at: "desc" },
    });
    return ok(keys);
  },
  { role: "admin" }
);

const Create = z.object({ name: z.string().min(1).max(80), expires_in_days: z.number().int().min(1).max(3650).optional() });

/** Returns the plaintext key ONCE as `key`; only its sha256 hash is stored. */
export const POST = withAuth(
  async (req, session) => {
    const blocked = proOnly(session.plan);
    if (blocked) return blocked;
    const limited = await limitOrResponse(`api-key-create:${session.org_id}`, { limit: 10, windowSec: 3600 });
    if (limited) return limited;
    const b = await parseBody(req, Create);
    const count = await prisma.api_keys.count({ where: { org_id: session.org_id } });
    if (count >= 20) return fail("API key limit reached (20)", 409);
    const { key, hash, prefix } = generateApiKey();
    const row = await prisma.api_keys.create({
      data: {
        org_id: session.org_id,
        name: b.name,
        key_hash: hash,
        key_prefix: prefix,
        created_by: session.user.id,
        expires_at: b.expires_in_days ? new Date(Date.now() + b.expires_in_days * 86400_000) : null,
      },
    });
    await audit(session, "api_key.create", "api_key", row.id, { after: { name: b.name } });
    return ok({ id: row.id, name: row.name, key_prefix: prefix, expires_at: row.expires_at, key }, 201);
  },
  { role: "admin" }
);

/** DELETE /api/keys?id=… */
export const DELETE = withAuth(
  async (req, session) => {
    const { id } = parseQuery(req, z.object({ id: z.string().uuid() }));
    const r = await prisma.api_keys.deleteMany({ where: { id, org_id: session.org_id } });
    if (!r.count) return fail("API key not found", 404);
    await audit(session, "api_key.revoke", "api_key", id);
    return ok({ id });
  },
  { role: "admin" }
);
