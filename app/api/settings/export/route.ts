import { z } from "zod";
import { NextResponse } from "next/server";
import { withAuth, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { audit } from "@/lib/audit";

const Q = z.object({ type: z.enum(["contacts", "campaigns", "calls"]) });

/** GET /api/settings/export?type=contacts|campaigns|calls → CSV download (admin). */
export const GET = withAuth(
  async (req, session) => {
    const { type } = parseQuery(req, Q);
    let csv: string;
    if (type === "contacts") {
      const rows = await prisma.contacts.findMany({ where: { org_id: session.org_id, is_active: true }, orderBy: { created_at: "asc" } });
      csv = toCsv(
        ["id", "full_name", "phone", "email", "company", "job_title", "source", "tags", "lead_score", "status", "wa_opt_out", "email_opt_out", "dnc", "created_at"],
        rows.map((c) => [c.id, c.full_name, c.phone, c.email, c.company, c.job_title, c.source, c.tags.join(";"), c.lead_score, c.status, c.wa_opt_out, c.email_opt_out, c.dnc, c.created_at])
      );
    } else if (type === "campaigns") {
      const rows = await prisma.campaigns.findMany({ where: { org_id: session.org_id }, orderBy: { created_at: "asc" } });
      csv = toCsv(
        ["id", "name", "channel", "type", "status", "scheduled_at", "sent_at", "stats", "created_at"],
        rows.map((c) => [c.id, c.name, c.channel, c.type, c.status, c.scheduled_at, c.sent_at, JSON.stringify(c.stats), c.created_at])
      );
    } else {
      const rows = await prisma.ai_calls.findMany({ where: { org_id: session.org_id }, orderBy: { created_at: "asc" }, include: { contact: { select: { full_name: true } } } });
      csv = toCsv(
        ["id", "contact", "to_number", "status", "outcome", "duration_seconds", "summary", "cost_inr", "attempt", "created_at"],
        rows.map((c) => [c.id, c.contact.full_name, c.to_number, c.status, c.outcome, c.duration_seconds, c.summary, c.cost_inr?.toString(), c.attempt, c.created_at])
      );
    }
    await audit(session, "data.export", "export", type);
    return new NextResponse("﻿" + csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${type}-${new Date().toISOString().slice(0, 10)}.csv"` },
    });
  },
  { role: "admin" }
);
