import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Inbound email through Resend Receiving (verified against Resend docs): event `email.received`, body fetched with
 * GET /emails/receiving/{id}, webhook signed with the Svix scheme (svix-id / svix-timestamp / svix-signature).
 *
 * Every org gets its own address `in-<16 hex>@<INBOUND_EMAIL_DOMAIN>` (derived from the inbox webhook_token). Outgoing
 * emails carry it as Reply-To, so customer replies land in the dashboard; customers can also write to it directly
 * (forward your support@ address to it).
 */

export const inboundDomain = (): string | null => process.env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase() || null;

export function inboundAddress(webhookToken: string): string | null {
  const d = inboundDomain();
  return d ? `in-${webhookToken.slice(0, 16)}@${d}` : null;
}

/** The 16-hex routing key if `addr` is one of our inbound addresses. */
export function routingKeyFromAddress(addr: string): string | null {
  const d = inboundDomain();
  if (!d) return null;
  const m = addr.trim().toLowerCase().match(/<?in-([a-f0-9]{16})@([a-z0-9.-]+)>?$/);
  return m && m[2] === d ? m[1]! : null;
}

export function verifySvix(headers: Headers, rawBody: string, secret: string, now = Date.now()): boolean {
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader || !secret) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 5 * 60) return false; // replay window
  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sigHeader.split(" ").some((part) => {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  message_id: string | null;
}

/** Fetch the full received email (webhooks carry metadata only). */
export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmail> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend receiving API ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const rawHeaders = j.headers;
  const headers: Record<string, string> = {};
  if (Array.isArray(rawHeaders)) for (const h of rawHeaders as { name?: string; value?: string }[]) if (h?.name) headers[h.name.toLowerCase()] = String(h.value ?? "");
  else if (rawHeaders && typeof rawHeaders === "object") for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
  const to = Array.isArray(j.to) ? (j.to as unknown[]).map(String) : [];
  return {
    id: String(j.id ?? emailId),
    from: String(j.from ?? ""),
    to,
    subject: String(j.subject ?? ""),
    text: typeof j.text === "string" ? j.text : "",
    html: typeof j.html === "string" ? j.html : "",
    headers,
    message_id: typeof j.message_id === "string" ? j.message_id : null,
  };
}

/** "Asha Verma <asha@x.com>" -> { name, email } */
export function parseAddress(raw: string): { name: string | undefined; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim() || undefined, email: m[2]!.trim().toLowerCase() };
  return { name: undefined, email: raw.trim().toLowerCase() };
}

/** Machine mail we must never answer (loops with other auto-responders, newsletters, bounces). */
export function isAutomatedMail(from: string, headers: Record<string, string>): boolean {
  const auto = headers["auto-submitted"];
  if (auto && auto.toLowerCase() !== "no") return true;
  if (/^(bulk|junk|list)$/i.test(headers["precedence"] ?? "")) return true;
  if (headers["x-auto-response-suppress"] || headers["list-id"] || headers["list-unsubscribe"]) return true;
  return /(^|[<\s])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?)[+@.-]/i.test(from);
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** The new text of a reply, without the quoted history and signature separators. */
export function cleanReplyText(text: string, html: string): string {
  const src = text.trim() || htmlToPlain(html);
  const out: string[] = [];
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^>/.test(line)) continue;
    if (/^On .{5,200} wrote:\s*$/i.test(line) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^From:\s.+@/i.test(line) && out.length > 0) break;
    if (/^-- ?$/.test(line)) break;
    out.push(line.replace(/[ \t ]+/g, " ").trimEnd());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
}

/** Reply subject for a customer: "Re: <their last subject>", falling back to a generic one. */
export async function replySubjectFor(orgId: string, contactId: string): Promise<string> {
  const last = await prisma.messages.findFirst({
    where: { org_id: orgId, contact_id: contactId, channel: "email", direction: "inbound" },
    orderBy: { created_at: "desc" },
    select: { content: true },
  });
  const first = last?.content.split("\n")[0]?.trim() ?? "";
  const m = first.match(/^Subject:\s*(.+)$/i);
  const subj = m?.[1]?.trim();
  if (!subj) return "Re: your message";
  return /^re:/i.test(subj) ? subj.slice(0, 200) : `Re: ${subj}`.slice(0, 200);
}
