import { prisma, type channel } from "@/lib/db";

const IMPORT_CHANNELS: channel[] = ["whatsapp", "email", "sms", "voice"];

/**
 * CSV / bulk import consent capture (H-06). Call ONLY when the importer explicitly ticked the attestation
 * ("I confirm these contacts have given consent to be contacted on the selected channels"). Records a
 * 'granted' ledger row with source "import_attested" per contact x channel and keeps the attester as evidence.
 *
 * Never grants consent to contacts that are DNC / opted out, or whose latest ledger entry is a revocation or
 * already a grant. Returns how many contact x channel rows were written.
 *
 * Wiring (agent C, app/api/contacts/import): add `consent_attested: boolean` and `consent_channels: channel[]` to the
 * request schema (default false / []); after the upsert call
 *   if (body.consent_attested) await applyImportConsent(orgId, ids, body.consent_channels, session.user.id)
 * Do NOT call it otherwise: unattested imports get no consent and so are never auto-contacted.
 */
export async function applyImportConsent(orgId: string, contactIds: string[], channels: channel[], attestedBy: string): Promise<number> {
  const chans = [...new Set(channels)].filter((c) => IMPORT_CHANNELS.includes(c));
  if (!chans.length || !contactIds.length) return 0;
  const attestedAt = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < contactIds.length; i += 500) {
    const ids = contactIds.slice(i, i + 500);
    const eligible = await prisma.contacts.findMany({
      where: { org_id: orgId, id: { in: ids }, is_active: true, dnc: false, wa_opt_out: false, email_opt_out: false },
      select: { id: true },
    });
    if (!eligible.length) continue;
    const eligibleIds = eligible.map((c) => c.id);
    const prior = await prisma.consents.findMany({
      where: { org_id: orgId, contact_id: { in: eligibleIds }, channel: { in: chans } },
      orderBy: { created_at: "desc" },
      select: { contact_id: true, channel: true, status: true },
    });
    const latest = new Map<string, string>();
    for (const p of prior) {
      const k = `${p.contact_id}:${p.channel}`;
      if (!latest.has(k)) latest.set(k, p.status);
    }
    const data = eligibleIds.flatMap((contact_id) =>
      chans
        .filter((c) => !latest.has(`${contact_id}:${c}`))
        .map((channel) => ({
          org_id: orgId,
          contact_id,
          channel,
          status: "granted" as const,
          source: "import_attested",
          evidence: { attested_by: attestedBy, attested_at: attestedAt },
        }))
    );
    if (data.length) written += (await prisma.consents.createMany({ data })).count;
  }
  return written;
}
