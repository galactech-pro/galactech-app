import { z } from "zod";
import { fail, ok, parseBody, safe, isCrossOriginMutation } from "@/lib/api";
import { createSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(200) });

export const POST = safe(async (req) => {
  if (isCrossOriginMutation(req)) return fail("Cross-origin request blocked", 403);
  const ip = clientIp(req);
  const body = await parseBody(req, schema);
  // Brute-force defence: per-IP and per-account (so a botnet can't hammer one account either).
  const limited =
    (await limitOrResponse(`login:ip:${ip}`, { limit: 20, windowSec: 600, failClosed: true })) ??
    (await limitOrResponse(`login:email:${body.email}`, { limit: 10, windowSec: 900, failClosed: true }));
  if (limited) return limited;

  // tenant-ok: login lookup by globally-unique email; this DEFINES the tenant
  const user = await prisma.users.findUnique({ where: { email: body.email }, select: { id: true, password_hash: true, is_active: true } });
  const good = await verifyPassword(body.password, user?.password_hash); // always runs a full scrypt (no timing oracle)
  if (!user || !good || !user.is_active) return fail("Invalid email or password.", 401);

  await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") });
  await prisma.users.update({ where: { id: user.id }, data: { last_seen_at: new Date() } }); // tenant-ok: keyed by verified user id
  return ok({ user_id: user.id });
});
