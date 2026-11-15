import { z } from "zod";
import { ok, parseBody, withAuth } from "@/lib/api";
import { detectPreset } from "@/lib/mailbox/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which provider hosts this address, and what the customer must do to get a password the app can use. */
export const POST = withAuth(
  async (req) => {
    const b = await parseBody(req, z.object({ email: z.string().trim().toLowerCase().email().max(200) }));
    const p = await detectPreset(b.email);
    return ok(p ? { detected: true, label: p.label, help: p.help, imap_host: p.imap_host, smtp_host: p.smtp_host } : { detected: false });
  },
  { role: "admin", rateLimit: { limit: 30, windowSec: 60 } }
);
