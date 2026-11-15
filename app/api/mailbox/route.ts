import { z } from "zod";
import { ApiError, ok, parseBody, withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { createInbox, toInboxCtx } from "@/lib/channels/inbox";
import { ALLOWED_IMAP_PORTS, ALLOWED_SMTP_PORTS, assertPublicHost, detectPreset } from "@/lib/mailbox/presets";
import { explainImapError, testImap } from "@/lib/mailbox/imap";
import { verifySmtp } from "@/lib/mailbox/smtp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Connect = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(4).max(200),
  from_name: z.string().trim().max(80).optional(),
  imap_host: z.string().trim().max(253).optional(),
  imap_port: z.number().int().optional(),
  smtp_host: z.string().trim().max(253).optional(),
  smtp_port: z.number().int().optional(),
});

/** Connected mailboxes of the org. Never returns the password. */
export const GET = withAuth(async (_req, session) => {
  const rows = await prisma.inboxes.findMany({ where: { org_id: session.org_id, channel: "email", provider: "imap" }, orderBy: { created_at: "asc" } });
  return ok(
    rows.map((r) => {
      let cfg: Record<string, unknown> = {};
      let broken = false;
      try {
        cfg = toInboxCtx(r).config;
      } catch {
        broken = true;
      }
      return {
        id: r.id,
        email: r.identifier,
        is_active: r.is_active,
        needs_reconnect: broken,
        last_polled_at: cfg.last_polled_at ?? null,
        last_error: cfg.last_error ?? null,
        created_at: r.created_at,
      };
    })
  );
});

/** Admin only. Verifies the login on BOTH servers before saving anything; the password is stored AES-GCM encrypted. */
export const POST = withAuth(
  async (req, session) => {
    const b = await parseBody(req, Connect);
    const preset = await detectPreset(b.email);
    const imap_host = b.imap_host || preset?.imap_host;
    const smtp_host = b.smtp_host || preset?.smtp_host;
    const imap_port = b.imap_port ?? preset?.imap_port ?? 993;
    const smtp_port = b.smtp_port ?? preset?.smtp_port ?? 465;
    if (!imap_host || !smtp_host) throw new ApiError(422, "We could not detect your mail provider. Enter the incoming (IMAP) and outgoing (SMTP) server addresses.");
    if (!ALLOWED_IMAP_PORTS.includes(imap_port) || !ALLOWED_SMTP_PORTS.includes(smtp_port)) throw new ApiError(422, "Use port 993 for incoming mail and 465 or 587 for outgoing mail.");
    try {
      await assertPublicHost(imap_host);
      await assertPublicHost(smtp_host);
    } catch (e) {
      throw new ApiError(422, e instanceof Error ? e.message : "Invalid mail server");
    }
    const password = b.password.replace(/\s+/g, ""); // Google shows app passwords with spaces

    let pos: { uidNext: number; uidValidity: string };
    try {
      pos = await testImap({ imap_host, imap_port, username: b.email, password });
    } catch (e) {
      throw new ApiError(422, `Incoming mail check failed: ${explainImapError(e)}`);
    }
    try {
      await verifySmtp({ smtp_host, smtp_port, username: b.email, password });
    } catch (e) {
      const m = (e as { code?: string }).code === "EAUTH" ? "the server did not accept the login" : ((e as Error).message ?? "could not connect").slice(0, 120);
      throw new ApiError(422, `Outgoing mail check failed: ${m}`);
    }

    const config = {
      imap_host, imap_port, smtp_host, smtp_port, username: b.email, password, from_name: b.from_name ?? "",
      last_uid: pos.uidNext - 1, uid_validity: pos.uidValidity, last_polled_at: new Date().toISOString(), last_error: null,
    };
    const existing = await prisma.inboxes.findFirst({ where: { org_id: session.org_id, channel: "email", identifier: b.email } });
    let id: string;
    if (existing) {
      if (existing.provider !== "imap") throw new ApiError(409, "That address is already used by another email connection");
      await prisma.inboxes.updateMany({ where: { id: existing.id, org_id: session.org_id }, data: { config: encrypt(JSON.stringify(config)), is_active: true } });
      id = existing.id;
    } else {
      const row = await createInbox(session.org_id, { channel: "email", provider: "imap", name: b.email, identifier: b.email, config });
      id = row.id;
    }
    return ok({ id, email: b.email, provider: preset?.label ?? "Custom server" }, 201);
  },
  { role: "admin", rateLimit: { limit: 10, windowSec: 60 } }
);

/** Admin only. Disconnect: stops polling and sending (history kept) and wipes the stored password. */
export const DELETE = withAuth(
  async (req, session) => {
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get("id"));
    const row = await prisma.inboxes.findFirst({ where: { id, org_id: session.org_id, channel: "email", provider: "imap" } });
    if (!row) throw new ApiError(404, "Mailbox not found");
    await prisma.inboxes.updateMany({ where: { id: row.id, org_id: session.org_id }, data: { is_active: false, config: encrypt(JSON.stringify({ disconnected: true })) } });
    return ok({ id: row.id, is_active: false });
  },
  { role: "admin" }
);
