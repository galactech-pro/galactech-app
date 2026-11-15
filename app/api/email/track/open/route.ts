import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { verifyTrackingToken } from "@/lib/email";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t");
  // Over the limit we still serve the pixel but skip the DB write (a broken image would look bad in the inbox). Generous limit: mailbox providers proxy images from shared IPs.
  const rl = await rateLimit(`track:${clientIp(req)}`, { limit: 600, windowSec: 60 });
  const id = !rl.ok ? null : token ? verifyTrackingToken(token) : null;
  if (id) {
    await prisma.messages
      .updateMany({ where: { id, channel: "email", opened_at: null }, data: { opened_at: new Date() } })
      .catch((e) => console.error("[email] open track failed", e));
  }
  return new NextResponse(GIF, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" },
  });
}
