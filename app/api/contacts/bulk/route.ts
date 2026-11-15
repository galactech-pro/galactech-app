import { z } from "zod";
import { NextResponse } from "next/server";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEvent } from "@/lib/inngest";
import { mapLimit } from "../../_shared/common";
import { toCsv } from "@/lib/csv";

const ids = z.array(z.string().uuid()).min(1).max(500);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_tag"), ids, tag: z.string().trim().min(1).max(50) }),
  z.object({ action: z.literal("remove_tag"), ids, tag: z.string().trim().min(1).max(50) }),
  z.object({ action: z.literal("assign_campaign"), ids, campaign_id: z.string().uuid() }),
  z.object({ action: z.literal("assign_owner"), ids, user_id: z.string().uuid().nullable() }),
  z.object({ action: z.literal("export"), ids }),
  z.object({ action: z.literal("delete"), ids }),
]);

/** export returns text/csv (not JSON); everything else returns { affected }. */
export const POST = withAuth(
  async (req, session) => {
    const body = await parseBody(req, schema);
    const orgId = session.org_id;
    const scope = { org_id: orgId, is_active: true, id: { in: body.ids } };

    switch (body.action) {
      case "add_tag": {
        const rows = await prisma.contacts.findMany({ where: scope, select: { id: true, tags: true } });
        const todo = rows.filter((r) => !r.tags.includes(body.tag));
        // tenant-ok: ids come from findMany scoped by org_id
        await mapLimit(todo, 25, (r) => prisma.contacts.update({ where: { id: r.id }, data: { tags: [...r.tags, body.tag] } }));
        await mapLimit(todo, 25, (r) => sendEvent("contact/tag.added", { org_id: orgId, contact_id: r.id, tag: body.tag }));
        await audit(session, "contact.bulk_add_tag", "contact", null, { after: { tag: body.tag, count: todo.length } });
        return ok({ affected: todo.length, matched: rows.length });
      }
      case "remove_tag": {
        const rows = await prisma.contacts.findMany({ where: { ...scope, tags: { has: body.tag } }, select: { id: true, tags: true } });
        // tenant-ok: ids come from findMany scoped by org_id
        await mapLimit(rows, 25, (r) => prisma.contacts.update({ where: { id: r.id }, data: { tags: r.tags.filter((t) => t !== body.tag) } }));
        await audit(session, "contact.bulk_remove_tag", "contact", null, { after: { tag: body.tag, count: rows.length } });
        return ok({ affected: rows.length });
      }
      case "assign_owner": {
        if (body.user_id) {
          const u = await prisma.users.findFirst({ where: { id: body.user_id, org_id: orgId, is_active: true }, select: { id: true } });
          if (!u) return fail("User not found", 422);
        }
        const res = await prisma.contacts.updateMany({ where: scope, data: { assigned_to: body.user_id } });
        await audit(session, "contact.bulk_assign_owner", "contact", null, { after: { user_id: body.user_id, count: res.count } });
        return ok({ affected: res.count });
      }
      case "assign_campaign": {
        const camp = await prisma.campaigns.findFirst({ where: { id: body.campaign_id, org_id: orgId } });
        if (!camp) return fail("Campaign not found", 404);
        if (camp.status !== "draft" && camp.status !== "scheduled") return fail("Only draft or scheduled campaigns can be changed", 409);
        const valid = await prisma.contacts.findMany({ where: scope, select: { id: true } });
        const filter = (camp.audience_filter ?? {}) as Record<string, unknown>;
        const existing = Array.isArray(filter.contact_ids) ? (filter.contact_ids as string[]) : [];
        const merged = [...new Set([...existing, ...valid.map((v) => v.id)])];
        // tenant-ok: campaign verified org-scoped by findFirst above
        await prisma.campaigns.update({ where: { id: camp.id }, data: { audience_filter: { ...filter, contact_ids: merged } } });
        await audit(session, "campaign.bulk_assign", "campaign", camp.id, { after: { added: valid.length } });
        return ok({ affected: valid.length, audience_size_ids: merged.length });
      }
      case "delete": {
        const res = await prisma.contacts.updateMany({ where: scope, data: { is_active: false } });
        await audit(session, "contact.bulk_delete", "contact", null, { after: { count: res.count } });
        return ok({ affected: res.count });
      }
      case "export": {
        const rows = await prisma.contacts.findMany({ where: scope, orderBy: { created_at: "desc" } });
        const csv = toCsv(
          ["name", "phone", "email", "company", "job_title", "status", "lead_score", "tags", "source", "created_at"],
          rows.map((r) => [r.full_name, r.phone, r.email, r.company, r.job_title, r.status, r.lead_score, r.tags.join(";"), r.source, r.created_at.toISOString()])
        );
        await audit(session, "contact.export", "contact", null, { after: { count: rows.length } });
        return new NextResponse("﻿" + csv, {
          headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="contacts.csv"' },
        });
      }
    }
  },
  { role: "member" }
);
