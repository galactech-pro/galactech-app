import { z } from "zod";
import { fail, ok, parseBody, safe, isCrossOriginMutation } from "@/lib/api";
import { createSession, destroyAllSessions } from "@/lib/auth";
import { consumeAuthToken } from "@/lib/auth-tokens";
import { prisma } from "@/lib/db";
import { hashPassword, passwordProblem } from "@/lib/password";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";

const schema = z.object({ token: z.string().min(10).max(200), password: z.string().max(200) });

/** Consumes the single-use reset token, sets the new password, revokes ALL existing sessions, signs in on this device. */
export const POST = safe(async (req) => {
  if (isCrossOriginMutation(req)) return fail("Cross-origin request blocked", 403);
  const ip = clientIp(req);
  const limited = await limitOrResponse(`reset:${ip}`, { limit: 10, windowSec: 600 });
  if (limited) return limited;
  const body = await parseBody(req, schema);
  const problem = passwordProblem(body.password);
  if (problem) return fail(`Password: ${problem}`, 422);

  const userId = await consumeAuthToken(body.token, "reset_password");
  if (!userId) return fail("This reset link is invalid or has expired.", 400);
  // tenant-ok: keyed by the user id bound to the single-use token. A reset also proves control of the inbox.
  await prisma.users.update({ where: { id: userId }, data: { password_hash: await hashPassword(body.password), email_verified_at: new Date() } });
  await destroyAllSessions(userId);
  await createSession(userId, { ip, userAgent: req.headers.get("user-agent") });
  return ok({ reset: true });
});
