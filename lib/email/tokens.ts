import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "@/lib/env";

export { appUrl };
export const fromAddress = () => process.env.EMAIL_FROM || "GalacTech <onboarding@resend.dev>";

// ───────────── HMAC tokens (secret derived from ENCRYPTION_KEY) ─────────────
function secret(label: string): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error("ENCRYPTION_KEY is required");
  return createHmac("sha256", Buffer.from(hex, "hex")).update(label).digest();
}
function sign(label: string, payload: string): string {
  return createHmac("sha256", secret(label)).update(payload).digest("base64url");
}
function packToken(label: string, payload: string): string {
  const p = Buffer.from(payload, "utf8").toString("base64url");
  return `${p}.${sign(label, p)}`;
}
function unpackToken(label: string, token: string): string | null {
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const expected = sign(label, p);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(p, "base64url").toString("utf8");
}

export function unsubscribeToken(contactId: string): string {
  return packToken("email-unsubscribe", contactId);
}
export function verifyUnsubscribeToken(token: string): string | null {
  return unpackToken("email-unsubscribe", token);
}

/** Tracking token binds a message id (and optionally a URL). */
export function trackingToken(messageId: string): string {
  return packToken("email-track", messageId);
}
export function verifyTrackingToken(token: string): string | null {
  return unpackToken("email-track", token);
}
/** Signature binding a click-redirect target to its message token (prevents open redirects). */
export function clickSignature(token: string, url: string): string {
  return sign("email-click", `${token}|${url}`);
}
export function verifyClickSignature(token: string, url: string, sig: string): boolean {
  const a = Buffer.from(sig);
  const b = Buffer.from(clickSignature(token, url));
  return a.length === b.length && timingSafeEqual(a, b);
}
