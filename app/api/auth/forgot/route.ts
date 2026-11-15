import { z } from "zod";
import { fail, ok, parseBody, safe, isCrossOriginMutation } from "@/lib/api";
import { prisma } from "@/lib/db";
import { issueAuthToken } from "@/lib/auth-tokens";
import { sendTransactional } from "@/lib/email";
import { appUrl } from "@/lib/env";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/** Always answers the same way, whether or not the account exists (no user enumeration). */
export const POST = safe(async (req) => {
  if (isCrossOriginMutation(req)) return fail("Cross-origin request blocked", 403);
  const { email } = await parseBody(req, schema);
  const limited = (await limitOrResponse(`forgot:ip:${clientIp(req)}`, { limit: 10, windowSec: 3600 })) ?? (await limitOrResponse(`forgot:email:${email}`, { limit: 3, windowSec: 3600 }));
  if (limited) return limited;

  // tenant-ok: password reset lookup by globally-unique email
  const user = await prisma.users.findUnique({ where: { email }, select: { id: true, full_name: true, is_active: true } });
  if (user?.is_active) {
    try {
      const token = await issueAuthToken(user.id, "reset_password");
      const url = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      if (!process.env.RESEND_API_KEY && process.env.NODE_ENV !== "production") console.info(`[auth] dev mode reset link for ${email}: ${url}`);
      else await sendTransactional("password_reset", email, { name: user.full_name ?? "there", url });
    } catch (e) {
      console.error("[auth] reset email failed", (e as Error).message);
    }
  }
  return ok({ sent: true });
});
