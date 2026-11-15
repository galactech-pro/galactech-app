import nodemailer from "nodemailer";
import { ChannelError } from "@/lib/channels/types";

export interface SmtpConfig {
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
}

function transport(c: SmtpConfig) {
  return nodemailer.createTransport({
    host: c.smtp_host,
    port: c.smtp_port,
    secure: c.smtp_port === 465, // 465 = implicit TLS; 587/2525 = STARTTLS (required below)
    requireTLS: c.smtp_port !== 465,
    auth: { user: c.username, pass: c.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { minVersion: "TLSv1.2" },
  });
}

/** Login check only (nothing is sent). */
export async function verifySmtp(c: SmtpConfig): Promise<void> {
  const t = transport(c);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

export async function sendViaSmtp(
  c: SmtpConfig,
  m: { from: string; fromName?: string; to: string; subject: string; html: string; text?: string; headers?: Record<string, string>; inReplyTo?: string }
): Promise<string> {
  const t = transport(c);
  try {
    const info = await t.sendMail({
      from: m.fromName ? { name: m.fromName.replace(/["\r\n]/g, ""), address: m.from } : m.from,
      to: m.to,
      subject: m.subject.replace(/[\r\n]+/g, " "),
      html: m.html,
      text: m.text,
      headers: m.headers,
      inReplyTo: m.inReplyTo,
    });
    return info.messageId;
  } catch (e) {
    throw classifySmtpError(e);
  } finally {
    t.close();
  }
}

/** Map nodemailer errors onto the outbound pipeline's three outcomes (see ChannelError). */
export function classifySmtpError(e: unknown): ChannelError {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const msg = (err.message ?? "SMTP error").slice(0, 200);
  if (err.code === "EAUTH") return new ChannelError("AUTH_FAILED", "Your mail server rejected the saved password. Reconnect the mailbox.", { httpStatus: 401 });
  if (err.responseCode && err.responseCode >= 500) return new ChannelError("PROVIDER_REJECTED", msg, { httpStatus: err.responseCode });
  if (err.responseCode && err.responseCode >= 400) return new ChannelError("RATE_LIMITED", msg, { retryable: true, httpStatus: err.responseCode });
  if (["ECONNECTION", "ENOTFOUND", "EDNS", "ECONNREFUSED", "ESOCKET"].includes(err.code ?? "") && !/Data|DATA/.test(msg)) return new ChannelError("NETWORK", msg, { retryable: true });
  return new ChannelError("NETWORK", msg, { ambiguous: true }); // timeouts mid-send: the server may have accepted it
}
