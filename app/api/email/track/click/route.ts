import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { verifyClickSignature, verifyTrackingToken } from "@/lib/email";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = sp.get("t") ?? "";
  const url = sp.get("u") ?? "";
  const sig = sp.get("s") ?? "";
  if (!token || !url || !sig || !/^https?:\/\//i.test(url) || !verifyClickSignature(token, url, sig)) {
    return NextResponse.json({ success: false, data: null, error: "Invalid link" }, { status: 400 });
  }
  const id = verifyTrackingToken(token);
  // The link itself is HMAC-signed so redirecting is safe; over the limit we redirect but skip the DB write.
  const rl = await rateLimit(`track:${clientIp(req)}`, { limit: 300, windowSec: 60 });
  if (id && rl.ok) {
    const now = new Date();
    await prisma.messages
      .updateMany({ where: { id, channel: "email" }, data: { clicked_at: now } })
      .then(() => prisma.messages.updateMany({ where: { id, channel: "email", opened_at: null }, data: { opened_at: now } }))
      .catch((e) => console.error("[email] click track failed", e));
  }
  return NextResponse.redirect(url, 302);
}
