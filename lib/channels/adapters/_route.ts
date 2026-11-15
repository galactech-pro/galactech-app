import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { clientIp, limitOrResponse } from "@/lib/rate-limit";
import { toInboxCtx } from "../inbox";
import type { ChannelKind, InboxCtx } from "../types";

/** Resolve a per-inbox webhook token to an active inbox of the expected channel. The org comes ONLY from this row. */
export async function inboxByToken(token: string, channel: ChannelKind): Promise<InboxCtx | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  // tenant-ok: routing by globally unique webhook_token; the org is taken FROM this row
  const row = await prisma.inboxes.findUnique({ where: { webhook_token: token } });
  if (!row || row.channel !== channel || !row.is_active) return null;
  try {
    return toInboxCtx(row);
  } catch {
    return null;
  }
}

/** Per-IP gate for webhook endpoints (cheap, before any DB lookup beyond the limiter). */
export function webhookGate(req: NextRequest, name: string, limit = 600): Promise<NextResponse | null> {
  return limitOrResponse(`wh:${name}:${clientIp(req)}`, { limit, windowSec: 60 });
}

export const notFound = () => new NextResponse("Not found", { status: 404 });
