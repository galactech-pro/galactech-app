import { issueAuthToken } from "@/lib/auth-tokens";
import { sendTransactional } from "@/lib/email";
import { appUrl } from "@/lib/env";
import { prisma } from "@/lib/db";

/**
 * Sends the "confirm your email" link. Never throws (signup must not fail because Resend is down).
 * In development without RESEND_API_KEY the account is auto-verified and the link is logged, so local work isn't blocked.
 */
export async function sendVerificationEmail(userId: string, email: string, name: string | null): Promise<void> {
  try {
    const token = await issueAuthToken(userId, "verify_email");
    const url = `${appUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`;
    if (!process.env.RESEND_API_KEY && process.env.NODE_ENV !== "production") {
      console.info(`[auth] dev mode, no RESEND_API_KEY: auto-verified ${email}; link would be ${url}`);
      // tenant-ok: keyed by the user id just created
      await prisma.users.update({ where: { id: userId }, data: { email_verified_at: new Date() } });
      return;
    }
    await sendTransactional("verify_email", email, { name: name ?? "there", url });
  } catch (e) {
    console.error("[auth] verification email failed", (e as Error).message);
  }
}
