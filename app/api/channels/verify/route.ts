import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toInboxCtx } from "@/lib/channels/inbox";
import { allowedOrigins, normalizeOrigin } from "@/lib/channels/adapters/_webchat";
import { assertPublicUrl, fetchText } from "@/lib/knowledge/crawl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Verify installation": fetches the customer's page and reports whether our chat code is in it, and whether the site is allowed. */
export const POST = withAuth(
  async (req, session) => {
    const b = await parseBody(req, z.object({ id: z.string().uuid(), url: z.string().trim().min(4).max(300) }));
    const row = await prisma.inboxes.findFirst({ where: { id: b.id, org_id: session.org_id, channel: "webchat", is_active: true } });
    if (!row) throw new ApiError(404, "Web chat channel not found");
    const target = /^https?:\/\//i.test(b.url) ? b.url : `https://${b.url}`;
    let page;
    try {
      await assertPublicUrl(target);
      page = await fetchText(target);
    } catch (e) {
      throw new ApiError(422, e instanceof Error ? e.message : "Could not open that address");
    }
    if (!page) throw new ApiError(422, "We could not open that page. Check the address and that the site is public.");
    const origin = normalizeOrigin(page.url);
    const bare = (o: string) => o.replace("://www.", "://");
    const allowed = !!origin && allowedOrigins(toInboxCtx(row)).some((a) => bare(a) === bare(origin));
    const tokenFound = page.body.includes(row.webhook_token);
    const scriptFound = /webchat\.js/i.test(page.body);
    const csp = /content-security-policy/i.test(page.body);
    let verdict: string;
    if (tokenFound) verdict = allowed ? "Installed and working. The chat bubble should appear on this page." : "The code is on the page, but this website is not in the allowed websites list, so the bubble will not load. Add it to the list.";
    else if (scriptFound) verdict = "A chat script is on the page, but it uses a different token. Copy the snippet again from this channel.";
    else verdict = "The chat code is not on this page. If you just added it, publish or redeploy the website and clear any cache, then check again.";
    return ok({ final_url: page.url, token_found: tokenFound, script_found: scriptFound, site_allowed: allowed, origin, csp_meta: csp, verdict });
  },
  { role: "admin", rateLimit: { limit: 10, windowSec: 60 } }
);
