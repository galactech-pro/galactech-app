import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { prisma, type inboxes } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { toInboxCtx } from "@/lib/channels/inbox";
import { processInboundEvents } from "@/lib/channels/inbound";
import type { InboundEvent, InboxCtx } from "@/lib/channels/types";
import { cleanReplyText, isAutomatedMail } from "@/lib/email/inbound";

export interface ImapConfig {
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
}

const MAX_PER_RUN = 25;
const MAX_MESSAGE_BYTES = 2_000_000;
const MAX_RUN_BYTES = 10_000_000;

function client(c: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: c.imap_host,
    port: c.imap_port,
    secure: c.imap_port === 993,
    auth: { user: c.username, pass: c.password },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 25_000,
    tls: { minVersion: "TLSv1.2" },
  });
}

/** Human message for the common failures (never includes the password). */
export function explainImapError(e: unknown): string {
  const err = e as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string };
  if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(err.responseText ?? err.message ?? "")) {
    return "The mail server did not accept that login. Use an app password (not your normal password) and make sure IMAP is turned on for the mailbox.";
  }
  if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(err.code ?? "")) return "Could not reach the mail server. Check the server address and port.";
  return (err.responseText || err.message || "Could not connect to the mailbox").slice(0, 200);
}

/** Connects, opens INBOX and returns the UID position, so only mail that arrives from now on is imported. */
export async function testImap(c: ImapConfig): Promise<{ uidNext: number; uidValidity: string }> {
  const ic = client(c);
  ic.on("error", () => undefined);
  try {
    await ic.connect();
    const mb = await ic.mailboxOpen("INBOX", { readOnly: true });
    return { uidNext: Number(mb.uidNext), uidValidity: String(mb.uidValidity) };
  } finally {
    await ic.logout().catch(() => ic.close());
  }
}

async function saveConfig(row: inboxes, patch: Record<string, unknown>): Promise<void> {
  const ctx = toInboxCtx(row);
  const next = { ...ctx.config, ...patch };
  await prisma.inboxes.updateMany({ where: { id: row.id, org_id: row.org_id }, data: { config: encrypt(JSON.stringify(next)) } });
}

const headerString = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "text" in v) return String((v as { text: unknown }).text);
  if (v && typeof v === "object" && "value" in v) return String((v as { value: unknown }).value);
  return v === undefined || v === null ? "" : String(v);
};

function headerRecord(p: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of p.headers) out[k.toLowerCase()] = headerString(v);
  return out;
}

export interface PollResult {
  imported: number;
  skipped: number;
  error?: string;
}

/**
 * Pull new mail for one connected mailbox. Position is tracked by IMAP UID (reset if the server's UIDVALIDITY changes).
 * Only mail received AFTER connecting is imported, mail is never modified or flagged as read, automated mail is skipped,
 * and a failure stops at the first problem message so nothing is skipped silently.
 */
export async function pollMailbox(row: inboxes): Promise<PollResult> {
  const inbox: InboxCtx = toInboxCtx(row);
  const cfg = inbox.config as unknown as ImapConfig & { last_uid?: number; uid_validity?: string };
  const own = inbox.identifier.toLowerCase();
  let imported = 0;
  let skipped = 0;

  const ic = client(cfg);
  ic.on("error", () => undefined);
  try {
    await ic.connect();
    const mb = await ic.mailboxOpen("INBOX", { readOnly: true });
    const validity = String(mb.uidValidity);
    const uidNext = Number(mb.uidNext);

    // first run, or the server renumbered the mailbox: start from "now" instead of importing years of history
    if (cfg.last_uid === undefined || cfg.uid_validity !== validity) {
      await saveConfig(row, { last_uid: uidNext - 1, uid_validity: validity, last_polled_at: new Date().toISOString(), last_error: null });
      return { imported: 0, skipped: 0 };
    }
    const from = cfg.last_uid + 1;
    if (uidNext <= from) {
      await saveConfig(row, { last_polled_at: new Date().toISOString(), last_error: null });
      return { imported: 0, skipped: 0 };
    }

    const batch: { uid: number; source: Buffer; size: number }[] = [];
    let bytes = 0;
    for await (const m of ic.fetch(`${from}:*`, { uid: true, source: true, size: true }, { uid: true })) {
      if (m.uid < from) continue; // "N:*" always includes the newest message even when N is beyond it
      if (batch.length >= MAX_PER_RUN || bytes > MAX_RUN_BYTES) break;
      const size = m.size ?? m.source?.length ?? 0;
      batch.push({ uid: m.uid, source: size > MAX_MESSAGE_BYTES ? Buffer.alloc(0) : (m.source as Buffer), size });
      bytes += size > MAX_MESSAGE_BYTES ? 0 : size;
    }
    batch.sort((a, b) => a.uid - b.uid);

    let lastGood = cfg.last_uid;
    let error: string | undefined;
    for (const item of batch) {
      if (item.source.length === 0) {
        lastGood = item.uid; // too large to import safely
        skipped++;
        continue;
      }
      let parsed: ParsedMail;
      try {
        parsed = await simpleParser(item.source);
      } catch {
        lastGood = item.uid;
        skipped++;
        continue;
      }
      const sender = parsed.from?.value?.[0];
      const fromEmail = sender?.address?.toLowerCase();
      const fromRaw = sender ? `${sender.name ?? ""} <${sender.address ?? ""}>` : "";
      const body = cleanReplyText(parsed.text ?? "", typeof parsed.html === "string" ? parsed.html : "");
      if (!fromEmail || fromEmail === own || isAutomatedMail(fromRaw, headerRecord(parsed)) || !body) {
        lastGood = item.uid;
        skipped++;
        continue;
      }
      const subject = (parsed.subject ?? "").trim();
      const ev: InboundEvent = {
        kind: "message",
        externalId: parsed.messageId || `imap:${validity}:${item.uid}`,
        sourceId: fromEmail,
        contactEmail: fromEmail,
        contactName: sender?.name || undefined,
        content: subject ? `Subject: ${subject}\n\n${body}` : body,
        contentType: "email",
        sentAt: parsed.date ?? new Date(),
      };
      try {
        const stats = await processInboundEvents(inbox, [ev]);
        if (stats.failed > 0) {
          error = "A message could not be processed and will be retried";
          break;
        }
        imported += stats.inserted;
        lastGood = item.uid;
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 150) : "processing failed";
        break;
      }
    }
    await saveConfig(row, { last_uid: lastGood, last_polled_at: new Date().toISOString(), last_error: error ?? null });
    return { imported, skipped, ...(error ? { error } : {}) };
  } catch (e) {
    const msg = explainImapError(e);
    await saveConfig(row, { last_polled_at: new Date().toISOString(), last_error: msg }).catch(() => undefined);
    return { imported, skipped, error: msg };
  } finally {
    await ic.logout().catch(() => ic.close());
  }
}
