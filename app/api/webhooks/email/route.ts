import { NextResponse, type NextRequest } from "next/server";
import { safe } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toInboxCtx } from "@/lib/channels/inbox";
import { processInboundEvents } from "@/lib/channels/inbound";
import { webhookGate } from "@/lib/channels/adapters/_route";
import { cleanReplyText, fetchReceivedEmail, isAutomatedMail, parseAddress, routingKeyFromAddress, verifySvix } from "@/lib/email/inbound";
import { fromAddress } from "@/lib/email/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ReceivedHook {
  type?: string;
  data?: { email_id?: string; from?: string; to?: string[]; received_for?: string[]; message_id?: string; subject?: string; created_at?: string };
}

/**
 * Resend "email.received" webhook (one URL for the whole Resend account). The org is derived ONLY from the recipient
 * address (in-<routing key>@<INBOUND_EMAIL_DOMAIN>), never from the payload body. Signature is verified (Svix scheme).
 */
export const POST = safe(async (req: NextRequest) => {
  const gated = await webhookGate(req, "email");
  if (gated) return gated;
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ success: false, error: "Inbound email is not configured" }, { status: 503 });

  const raw = await req.text();
  if (raw.length > 512 * 1024) return new NextResponse("Too large", { status: 413 });
  if (!verifySvix(req.headers, raw, secret)) return new NextResponse("Invalid signature", { status: 401 });

  let hook: ReceivedHook;
  try {
    hook = JSON.parse(raw) as ReceivedHook;
  } catch {
    return NextResponse.json({ success: true });
  }
  if (hook.type !== "email.received" || !hook.data?.email_id) return NextResponse.json({ success: true }); // other event types are ignored

  const recipients = [...(hook.data.to ?? []), ...(hook.data.received_for ?? [])];
  const key = recipients.map(routingKeyFromAddress).find((k): k is string => !!k);
  if (!key) return NextResponse.json({ success: true }); // not for one of our inboxes

  // tenant-ok: routing by the unguessable per-inbox key; the org is taken FROM this row
  const row = await prisma.inboxes.findFirst({ where: { channel: "email", is_active: true, webhook_token: { startsWith: key } } });
  if (!row) return NextResponse.json({ success: true });
  const inbox = toInboxCtx(row);

  const mail = await fetchReceivedEmail(hook.data.email_id);
  const sender = parseAddress(mail.from || hook.data.from || "");
  if (!sender.email.includes("@")) return NextResponse.json({ success: true });
  const ours = parseAddress(fromAddress()).email;
  if (sender.email === ours || isAutomatedMail(mail.from, mail.headers)) return NextResponse.json({ success: true, skipped: "automated" });

  const body = cleanReplyText(mail.text, mail.html);
  if (!body) return NextResponse.json({ success: true, skipped: "empty" });
  const subject = (mail.subject || hook.data.subject || "").trim();
  // The subject is kept as the first line so replies can say "Re: <subject>" (see replySubjectFor)
  const content = subject ? `Subject: ${subject}\n\n${body}` : body;

  const stats = await processInboundEvents(inbox, [
    {
      kind: "message",
      externalId: mail.message_id || mail.id,
      sourceId: sender.email,
      contactEmail: sender.email,
      contactName: sender.name,
      content,
      contentType: "email",
      sentAt: hook.data.created_at ? new Date(hook.data.created_at) : new Date(),
    },
  ]);
  if (stats.failed > 0) return NextResponse.json({ success: false, error: "processing failed" }, { status: 500 }); // Resend retries
  return NextResponse.json({ success: true });
});
