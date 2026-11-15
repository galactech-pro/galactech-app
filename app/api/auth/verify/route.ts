import { NextResponse, type NextRequest } from "next/server";
import { consumeAuthToken } from "@/lib/auth-tokens";
import { prisma } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/** Email-confirmation link target. GET is safe here: it only flips a flag for the token holder and requires no session. */
export async function GET(req: NextRequest) {
  const base = appUrl();
  const rl = await rateLimit(`verify:${clientIp(req)}`, { limit: 20, windowSec: 600 });
  if (!rl.ok) return NextResponse.redirect(`${base}/login?error=${encodeURIComponent("Too many attempts. Try again later.")}`);
  const userId = await consumeAuthToken(req.nextUrl.searchParams.get("token") ?? "", "verify_email");
  if (!userId) return NextResponse.redirect(`${base}/login?error=${encodeURIComponent("Link expired or invalid. Sign in and request a new one.")}`);
  // tenant-ok: keyed by the user id bound to the single-use token
  await prisma.users.update({ where: { id: userId }, data: { email_verified_at: new Date() } });
  return NextResponse.redirect(`${base}/dashboard?verified=1`);
}
