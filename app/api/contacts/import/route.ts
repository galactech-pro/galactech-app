import Papa from "papaparse";
import { z } from "zod";
import { withAuth, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkLimit, incrementUsage } from "@/lib/limits";
import { normalizePhone } from "@/lib/utils";
import { audit } from "@/lib/audit";
import { sendEvent } from "@/lib/inngest";
import { applyImportConsent } from "@/lib/compliance/import-consent";
import { mapLimit } from "../../_shared/common";

const MAX_ROWS = 5000;
const MAX_BYTES = 5 * 1024 * 1024;

const FIELD_ALIASES: Record<string, string[]> = {
  full_name: ["name", "full name", "fullname", "full_name", "contact name", "customer name", "contact"],
  first_name: ["first name", "firstname", "first_name", "given name"],
  last_name: ["last name", "lastname", "last_name", "surname", "family name"],
  phone: ["phone", "phone number", "mobile", "mobile number", "whatsapp", "whatsapp number", "contact number", "tel", "telephone", "cell"],
  email: ["email", "email address", "e-mail", "mail"],
  company: ["company", "company name", "organisation", "organization", "business", "business name"],
  job_title: ["job title", "title", "designation", "role", "position"],
  source: ["source", "lead source"],
  tags: ["tags", "tag", "labels"],
};
const FIELDS = Object.keys(FIELD_ALIASES);

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

function autoMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const n = norm(h);
    for (const field of FIELDS) {
      if (map[h]) break;
      if (norm(field) === n || FIELD_ALIASES[field].some((a) => norm(a) === n)) {
        if (!Object.values(map).includes(field)) map[h] = field;
      }
    }
  }
  return map;
}

/**
 * multipart/form-data: file (CSV, required), tags (comma separated, optional), mapping (JSON {csvHeader: field}, optional),
 * consent_attested=true + consent_channels (comma separated: whatsapp,email,sms,voice) records attested consent for the
 * imported contacts (H-06); without the attestation they get no consent and are never auto-contacted.
 * preview=true to only return detected headers/mapping without writing.
 */
export const POST = withAuth(
  async (req, session) => {
    const form = await req.formData().catch(() => null);
    if (!form) return fail("Expected multipart/form-data", 400);
    const file = form.get("file");
    if (!(file instanceof File)) return fail("CSV file is required (field 'file')", 422);
    if (file.size > MAX_BYTES) return fail("File too large (max 5 MB)", 413);

    const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: "greedy" });
    const headers = parsed.meta.fields ?? [];
    if (!headers.length) return fail("CSV has no header row", 422);

    let mapping = autoMap(headers);
    const rawMapping = form.get("mapping");
    if (typeof rawMapping === "string" && rawMapping) {
      try {
        mapping = z.record(z.string()).parse(JSON.parse(rawMapping));
      } catch {
        return fail("Invalid mapping JSON", 422);
      }
    }
    if (form.get("preview") === "true") {
      return ok({ headers, mapping, fields: FIELDS, sample: parsed.data.slice(0, 5), total_rows: parsed.data.length });
    }

    const inv = Object.entries(mapping);
    const hasName = inv.some(([, f]) => f === "full_name" || f === "first_name");
    if (!inv.some(([, f]) => f === "phone") || !hasName) {
      return fail("Could not find phone and name columns. Provide a 'mapping'.", 422, "MAPPING_REQUIRED");
    }
    if (parsed.data.length > MAX_ROWS) return fail(`Too many rows (max ${MAX_ROWS} per import)`, 422);

    const importTags = String(form.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const invalid: { row: number; reason: string; data: Record<string, string> }[] = [];
    let duplicates = 0;

    interface Row { full_name: string; phone: string; email: string | null; company: string | null; job_title: string | null; source: string; tags: string[] }
    const seen = new Set<string>();
    const rows: Row[] = [];
    parsed.data.forEach((raw, i) => {
      const v: Record<string, string> = {};
      for (const [h, f] of inv) v[f] = (raw[h] ?? "").trim();
      const name = v.full_name || [v.first_name, v.last_name].filter(Boolean).join(" ");
      if (!name) return void invalid.push({ row: i + 2, reason: "Missing name", data: raw });
      const phone = normalizePhone(v.phone ?? "");
      if (!phone) return void invalid.push({ row: i + 2, reason: "Invalid phone", data: raw });
      let email: string | null = v.email || null;
      if (email && !z.string().email().safeParse(email).success) return void invalid.push({ row: i + 2, reason: "Invalid email", data: raw });
      if (!email) email = null;
      if (seen.has(phone)) return void duplicates++;
      seen.add(phone);
      const rowTags = (v.tags ?? "").split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
      rows.push({
        full_name: name, phone, email, company: v.company || null, job_title: v.job_title || null,
        source: v.source || "import", tags: [...new Set([...rowTags, ...importTags])],
      });
    });

    const existing = await prisma.contacts.findMany({
      where: { org_id: session.org_id, phone: { in: rows.map((r) => r.phone) } },
      select: { id: true, phone: true, is_active: true },
    });
    const byPhone = new Map(existing.map((e) => [e.phone, e]));
    const toCreate: Row[] = [];
    const toReactivate: { id: string; row: Row }[] = [];
    for (const r of rows) {
      const e = byPhone.get(r.phone);
      if (!e) toCreate.push(r);
      else if (e.is_active) duplicates++;
      else toReactivate.push({ id: e.id, row: r });
    }

    const netNew = toCreate.length + toReactivate.length;
    if (netNew > 0) await checkLimit(session.org_id, "contacts", netNew);

    if (toCreate.length) {
      await prisma.contacts.createMany({
        data: toCreate.map((r) => ({ ...r, org_id: session.org_id })),
        skipDuplicates: true,
      });
    }
    for (const { id, row } of toReactivate) {
      // tenant-ok: id from an org-scoped lookup
      await prisma.contacts.update({ where: { id }, data: { ...row, is_active: true } });
    }

    if (netNew > 0) {
      await incrementUsage(session.org_id, "contacts", netNew);
      const created = await prisma.contacts.findMany({
        where: { org_id: session.org_id, phone: { in: [...toCreate, ...toReactivate.map((x) => x.row)].map((r) => r.phone) } },
        select: { id: true, tags: true },
      });
      if (String(form.get("consent_attested") ?? "") === "true") {
        const chans = z.array(z.enum(["whatsapp", "email", "sms", "voice"])).safeParse(String(form.get("consent_channels") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
        if (chans.success && chans.data.length) await applyImportConsent(session.org_id, created.map((c) => c.id), chans.data, session.user.id);
      }
      await mapLimit(created, 25, async (c) => {
        await sendEvent("contact/created", { org_id: session.org_id, contact_id: c.id });
        for (const tag of c.tags) await sendEvent("contact/tag.added", { org_id: session.org_id, contact_id: c.id, tag });
      });
    }

    await audit(session, "contact.import", "contact", null, { after: { created: netNew, duplicates, invalid: invalid.length } });
    return ok({ created: netNew, duplicates, invalid: invalid.slice(0, 200), invalid_count: invalid.length, mapping });
  },
  { role: "member" }
);
