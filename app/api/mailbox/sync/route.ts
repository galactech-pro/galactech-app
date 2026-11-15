import { ok, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toInboxCtx } from "@/lib/channels/inbox";
import { pollMailbox } from "@/lib/mailbox/imap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called by the open Inbox every minute: pulls new mail for this organisation's connected mailboxes that have not been
 * checked in the last 40 seconds. Works without the background scheduler, so mail arrives while anyone is looking at the Inbox.
 */
export const POST = withAuth(
  async (_req, session) => {
    const rows = await prisma.inboxes.findMany({ where: { org_id: session.org_id, channel: "email", provider: "imap", is_active: true }, take: 5 });
    let imported = 0;
    let checked = 0;
    for (const r of rows) {
      let last = 0;
      try {
        last = Date.parse(String(toInboxCtx(r).config.last_polled_at ?? "")) || 0;
      } catch {
        continue; // undecryptable: needs reconnect
      }
      if (Date.now() - last < 40_000) continue;
      checked++;
      imported += (await pollMailbox(r)).imported;
    }
    return ok({ checked, imported });
  },
  { role: "member", rateLimit: { limit: 20, windowSec: 60 } }
);
