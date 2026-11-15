import { withAuth, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { sendVerificationEmail } from "../_lib/verification";

/** Re-sends the confirmation email for the signed-in user. */
export const POST = withAuth(
  async (_req, session) => {
    if (session.user.email_verified) return ok({ already_verified: true });
    await sendVerificationEmail(session.user.id, session.user.email, session.user.full_name);
    const u = await prisma.users.findUnique({ where: { id: session.user.id }, select: { email_verified_at: true } }); // tenant-ok: own user row
    return ok({ sent: true, verified: !!u?.email_verified_at });
  },
  { rateLimit: { limit: 3, windowSec: 600 } }
);
