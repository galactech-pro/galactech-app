import { prisma, type channel } from "@/lib/db";
import { isStopKeyword } from "./stop-keywords";

export type Purpose = "marketing" | "service" | "transactional";

export type ComplianceCode =
  | "CONTACT_INACTIVE"
  | "OPTED_OUT"
  | "DNC"
  | "NO_CONSENT"
  | "AUTO_OUTREACH_DISABLED"
  | "OUTSIDE_CALL_HOURS";

export class ComplianceError extends Error {
  name = "ComplianceError";
  constructor(public code: ComplianceCode, message: string) {
    super(message);
  }
}

/** Local hour (0-23) in an IANA timezone. */
export function localHour(tz: string, at: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: tz }).format(at);
  return Number(h) % 24;
}

/** True when local hour h is inside [start,end) (supports windows that wrap midnight). */
export function inCallWindow(h: number, start: number, end: number): boolean {
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

/**
 * THE single pre-send gate. Every send path (inbox reply, campaigns, automations, workflows, voice)
 * MUST call this immediately before contacting a person, and treat ComplianceError as "do not send".
 *
 *  - purpose "service"/"transactional": replies to the contact's own message, receipts, invites — only hard opt-outs/DNC block.
 *  - purpose "marketing": additionally needs a granted consent row for the channel.
 *  - automated=true (automations/workflows/AI): additionally needs org.auto_outreach_enabled.
 *  - voice: only inside the org's configured calling window (org.call_window_start/end in org.timezone).
 *    NOTE: the window is configurable and defaults to 09:00–21:00; the legal rule behind it is UNVERIFIED
 *    (see docs/research/01) — confirm with counsel before enabling outbound AI calls in production.
 */
export async function assertCanContact(
  orgId: string,
  contactId: string,
  ch: channel,
  opts: { purpose: Purpose; automated?: boolean; now?: Date }
): Promise<void> {
  const contact = await prisma.contacts.findFirst({
    where: { id: contactId, org_id: orgId },
    select: { is_active: true, dnc: true, wa_opt_out: true, email_opt_out: true },
  });
  if (!contact || !contact.is_active) throw new ComplianceError("CONTACT_INACTIVE", "Contact not found or inactive");

  if (ch === "email" ? contact.email_opt_out : contact.wa_opt_out && ch !== "voice") {
    throw new ComplianceError("OPTED_OUT", "Contact has opted out of this channel");
  }
  // DNC means "do not contact": it blocks voice/sms always and every marketing message (incl. email)
  if (contact.dnc && (ch === "voice" || ch === "sms" || opts.purpose === "marketing")) {
    throw new ComplianceError("DNC", "Contact is on the Do-Not-Contact list");
  }

  const org = await prisma.organisations.findUnique({
    where: { id: orgId },
    select: { timezone: true, call_window_start: true, call_window_end: true, auto_outreach_enabled: true },
  });
  if (!org) throw new ComplianceError("CONTACT_INACTIVE", "Organisation not found");

  if (opts.automated && opts.purpose === "marketing" && !org.auto_outreach_enabled) {
    throw new ComplianceError("AUTO_OUTREACH_DISABLED", "Automatic outreach is disabled for this organisation");
  }

  if (opts.purpose === "marketing") {
    const latest = await prisma.consents.findFirst({
      where: { org_id: orgId, contact_id: contactId, channel: ch },
      orderBy: { created_at: "desc" },
      select: { status: true },
    });
    if (latest?.status !== "granted") throw new ComplianceError("NO_CONSENT", "No recorded consent for this channel");
  }

  if (ch === "voice") {
    if (!inCallWindow(localHour(org.timezone, opts.now), org.call_window_start, org.call_window_end)) {
      throw new ComplianceError("OUTSIDE_CALL_HOURS", "Outside the configured calling window");
    }
  }
}

/** Append a consent ledger entry (never update/delete rows — the ledger is the audit trail). */
export async function recordConsent(
  orgId: string,
  contactId: string,
  ch: channel,
  status: "granted" | "revoked",
  source: string,
  evidence?: Record<string, string | number | boolean | null>
): Promise<void> {
  await prisma.consents.create({ data: { org_id: orgId, contact_id: contactId, channel: ch, status, source, evidence } });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Workstream A additions: non-throwing gate, dial-window helpers, consent capture, STOP handling.
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ContactGate {
  allowed: boolean;
  code?: ComplianceCode;
  message?: string;
}

/**
 * Non-throwing wrapper around assertCanContact for workflows. A ComplianceError is an expected SKIP (log it, do not
 * fail or retry the step). Any other error is a real failure and is rethrown.
 * Defaults to the strictest purpose: marketing + automated.
 */
export async function safeContact(
  orgId: string,
  contactId: string,
  ch: channel,
  opts: { purpose?: Purpose; automated?: boolean; now?: Date } = {}
): Promise<ContactGate> {
  try {
    await assertCanContact(orgId, contactId, ch, { purpose: opts.purpose ?? "marketing", automated: opts.automated ?? true, now: opts.now });
    return { allowed: true };
  } catch (e) {
    if (e instanceof ComplianceError) {
      console.info(`[compliance] skip contact=${contactId} channel=${ch} code=${e.code}`);
      return { allowed: false, code: e.code, message: e.message };
    }
    throw e;
  }
}

/** First instant at/after `from` that is inside the org's calling window (30-min resolution, searches 3 days). */
export function nextCallWindowStart(tz: string, start: number, end: number, from: Date = new Date()): Date {
  const step = 30 * 60 * 1000;
  let t = new Date(Math.ceil(from.getTime() / step) * step);
  for (let i = 0; i < 144; i++, t = new Date(t.getTime() + step)) {
    if (inCallWindow(localHour(tz, t), start, end)) return t;
  }
  return t;
}

export interface DialGate extends ContactGate {
  /** Set when code === OUTSIDE_CALL_HOURS: the next time a call is allowed. Use step.sleepUntil(retryAt). */
  retryAt?: Date;
}

/**
 * Pre-dial gate for retry / scheduled / workflow dialing (agent C: call it at the top of call-retry and
 * scheduled-calls and in the campaign voice path). Applies DNC, opt-out, consent, auto-outreach and calling window.
 * `automated` defaults true; pass false for a human-initiated one-off call (consent still required unless purpose is service).
 */
export async function canDialNow(
  orgId: string,
  contactId: string,
  opts: { purpose?: Purpose; automated?: boolean; now?: Date } = {}
): Promise<DialGate> {
  const g = await safeContact(orgId, contactId, "voice", opts);
  if (g.allowed || g.code !== "OUTSIDE_CALL_HOURS") return g;
  const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { timezone: true, call_window_start: true, call_window_end: true } });
  return org ? { ...g, retryAt: nextCallWindowStart(org.timezone, org.call_window_start, org.call_window_end, opts.now) } : g;
}

/** Latest consent status per channel for a contact. */
export async function latestConsents(orgId: string, contactId: string): Promise<Partial<Record<channel, "granted" | "revoked">>> {
  const rows = await prisma.consents.findMany({
    where: { org_id: orgId, contact_id: contactId },
    orderBy: { created_at: "desc" },
    select: { channel: true, status: true },
  });
  const out: Partial<Record<channel, "granted" | "revoked">> = {};
  for (const r of rows) if (!out[r.channel]) out[r.channel] = r.status;
  return out;
}

/** True when org.auto_outreach_enabled AND the contact has at least one currently-granted channel (H-06 gate for new-contact triggers). */
export async function autoOutreachAllowed(orgId: string, contactId: string): Promise<boolean> {
  const org = await prisma.organisations.findUnique({ where: { id: orgId }, select: { auto_outreach_enabled: true } });
  if (!org?.auto_outreach_enabled) return false;
  return Object.values(await latestConsents(orgId, contactId)).includes("granted");
}

/** Public form / integration receiver (Typeform, Shopify...) captured an explicit opt-in. Source "form" unless given. */
export async function recordFormConsent(
  orgId: string,
  contactId: string,
  channels: channel[],
  evidence?: Record<string, string | number | boolean | null>,
  source = "form"
): Promise<void> {
  for (const ch of new Set(channels)) await recordConsent(orgId, contactId, ch, "granted", source, evidence);
}

/**
 * DOCUMENTED NO-OP (policy): an inbound message does NOT create marketing consent. It only opens the 24h
 * customer-service window, and assertCanContact already allows purpose "service" replies without a consent row.
 * Marketing consent comes ONLY from: attested import (applyImportConsent), public form / integration opt-in
 * (recordFormConsent), an explicit WhatsApp/website opt-in capture, or manual/API entry (recordConsent).
 * See docs/COMPLIANCE.md. Whether an inbound message could ever suffice is an open question (docs/OPEN_QUESTIONS.md).
 * Kept exported (always returns false, writes nothing) so existing callers compile.
 */
export async function recordInboundConsent(
  _orgId: string,
  _contactId: string,
  _ch: channel,
  _evidence?: Record<string, string | number | boolean | null>
): Promise<boolean> {
  return false;
}

export { isStopKeyword } from "./stop-keywords";

/**
 * Inbound text was a STOP keyword: set the opt-out flag and append a 'revoked' consent row.
 * Scope (env STOP_SCOPE): "all" (default, conservative: also revokes voice/sms/email marketing consent) or "channel".
 * Returns true when it was an opt-out. Caller (inbound webhook) should send the confirmation reply (purpose "service").
 */
export async function applyStopKeyword(orgId: string, contactId: string, ch: channel, text: string): Promise<boolean> {
  if (!isStopKeyword(text)) return false;
  const scopeAll = (process.env.STOP_SCOPE ?? "all").toLowerCase() !== "channel";
  const channels: channel[] = scopeAll ? ["whatsapp", "email", "sms", "voice"] : [ch];
  const flags: { wa_opt_out?: true; email_opt_out?: true } = {};
  if (scopeAll || ch === "whatsapp" || ch === "sms") flags.wa_opt_out = true;
  if (scopeAll || ch === "email") flags.email_opt_out = true;
  await prisma.contacts.updateMany({ where: { id: contactId, org_id: orgId }, data: flags });
  for (const c of channels) await recordConsent(orgId, contactId, c, "revoked", "stop_keyword", { keyword_text: text.slice(0, 60), via: ch });
  return true;
}
