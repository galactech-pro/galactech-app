import { safe, ok, parseBody } from "@/lib/api";
import { publicGuard } from "@/app/api/public/_guard";
import { InboundContact, upsertInboundContact } from "@/app/api/public/_contact";

/** POST /api/public/v1/contacts  (Authorization: Bearer or_live_…) — Pro plan. */
export const POST = safe(async (req) => {
  const g = await publicGuard(req);
  if ("response" in g) return g.response;
  const auth = g.auth;
  const body = await parseBody(req, InboundContact);
  const { contact, created } = await upsertInboundContact(auth.org_id, body, "api");
  return ok({ id: contact.id, created }, created ? 201 : 200);
});
