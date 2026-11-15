import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { pollMailbox } from "@/lib/mailbox/imap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Check now" button: pull new mail for one mailbox immediately. */
export const POST = withAuth(
  async (req, session) => {
    const b = await parseBody(req, z.object({ id: z.string().uuid() }));
    const row = await prisma.inboxes.findFirst({ where: { id: b.id, org_id: session.org_id, channel: "email", provider: "imap", is_active: true } });
    if (!row) throw new ApiError(404, "Mailbox not found");
    return ok(await pollMailbox(row));
  },
  { role: "admin", rateLimit: { limit: 12, windowSec: 60 } }
);
