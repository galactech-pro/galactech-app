import { z } from "zod";
import type { Prisma } from "@/lib/db";

export const uuid = z.string().uuid();

export const pageSchema = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
};

// CSV helpers live in lib/csv.ts (formula-injection safe, audit M-03). Re-exported for existing imports.
export { csvCell as csvEscape, toCsv } from "@/lib/csv";

/** Run `fn` over `items` with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

export const customFieldsSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const contactStatusEnum = z.enum(["new", "contacted", "qualified", "demo", "won", "lost"]);

/** Filter schema shared by contact list, bulk, and campaign audiences. */
export interface ContactFilter {
  q?: string;
  tags?: string[];
  score_min?: number;
  score_max?: number;
  status?: string[];
  assigned_to?: string;
  contacted_within_days?: number;
  inactive_days?: number;
  opt_out?: "wa" | "email" | "dnc" | "any";
  contact_ids?: string[];
}

export function buildContactWhere(orgId: string, f: ContactFilter): Prisma.contactsWhereInput {
  const and: Prisma.contactsWhereInput[] = [];
  if (f.q) {
    and.push({
      OR: [
        { full_name: { contains: f.q, mode: "insensitive" } },
        { phone: { contains: f.q } },
        { email: { contains: f.q, mode: "insensitive" } },
        { company: { contains: f.q, mode: "insensitive" } },
      ],
    });
  }
  if (f.tags?.length) and.push({ tags: { hasSome: f.tags } });
  if (f.score_min !== undefined || f.score_max !== undefined) {
    and.push({ lead_score: { gte: f.score_min, lte: f.score_max } });
  }
  if (f.status?.length) and.push({ status: { in: f.status as never[] } });
  if (f.assigned_to) and.push({ assigned_to: f.assigned_to });
  if (f.contacted_within_days) {
    and.push({ last_contacted_at: { gte: new Date(Date.now() - f.contacted_within_days * 864e5) } });
  }
  if (f.inactive_days) {
    const cutoff = new Date(Date.now() - f.inactive_days * 864e5);
    and.push({ OR: [{ last_contacted_at: null }, { last_contacted_at: { lt: cutoff } }] });
  }
  if (f.opt_out === "wa") and.push({ wa_opt_out: true });
  else if (f.opt_out === "email") and.push({ email_opt_out: true });
  else if (f.opt_out === "dnc") and.push({ dnc: true });
  else if (f.opt_out === "any") and.push({ OR: [{ wa_opt_out: true }, { email_opt_out: true }, { dnc: true }] });
  if (f.contact_ids?.length) and.push({ id: { in: f.contact_ids } });
  return { org_id: orgId, is_active: true, AND: and };
}
