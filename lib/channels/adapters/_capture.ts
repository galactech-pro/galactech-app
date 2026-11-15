import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/utils";
import { isUniqueViolation } from "../inbox";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * Optional visitor/caller details (web chat form, API channel) applied to the contact AFTER the message was ingested.
 * Never overwrites existing values: email only when empty, phone only when the contact still has the namespaced
 * placeholder phone ("<channel>:<id>") and no other contact in the org owns that number.
 */
export async function applyContactDetails(
  orgId: string,
  inboxId: string,
  sourceId: string,
  d: { email?: unknown; phone?: unknown; name?: unknown }
): Promise<void> {
  const ci = await prisma.contact_inboxes.findUnique({ where: { inbox_id_source_id: { inbox_id: inboxId, source_id: sourceId } }, select: { contact_id: true } });
  if (!ci) return;
  const email = typeof d.email === "string" && EMAIL_RE.test(d.email.trim()) ? d.email.trim().toLowerCase().slice(0, 254) : null;
  if (email) await prisma.contacts.updateMany({ where: { id: ci.contact_id, org_id: orgId, email: null }, data: { email } });
  const phone = typeof d.phone === "string" ? normalizePhone(d.phone.trim().slice(0, 32)) : null;
  if (phone) {
    const clash = await prisma.contacts.findFirst({ where: { org_id: orgId, phone, id: { not: ci.contact_id } }, select: { id: true } });
    if (!clash) {
      try {
        const cur = await prisma.contacts.findFirst({ where: { id: ci.contact_id, org_id: orgId }, select: { phone: true } });
        if (cur && /^[a-z]+:/.test(cur.phone)) await prisma.contacts.updateMany({ where: { id: ci.contact_id, org_id: orgId, phone: cur.phone }, data: { phone } });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
  }
}
