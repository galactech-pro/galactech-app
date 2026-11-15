import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { decrypt, encrypt } from "@/lib/crypto";
import { renderSimple, sendSystemEmail } from "@/lib/email";

/**
 * Emailed one-time codes that confirm sensitive actions (adding or deleting private knowledge).
 * 6 digits, valid 10 minutes, 5 attempts, single use, max 5 requests per user per hour. The pending action is stored
 * encrypted and only executed after the code is confirmed by the SAME user in the SAME org.
 */
const TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_PER_HOUR = 5;

export type OtpPurpose = "kb_add_private" | "kb_delete";

const hashCode = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest("hex");

const LABEL: Record<OtpPurpose, string> = {
  kb_add_private: "add private information to your knowledge base",
  kb_delete: "delete private information from your knowledge base",
};

export function maskEmail(e: string): string {
  const [u = "", d = ""] = e.split("@");
  return `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}`;
}

export async function issueOtp(user: { id: string; email: string }, orgId: string, purpose: OtpPurpose, payload: unknown): Promise<{ otp_id: string; sent_to: string }> {
  const recent = await prisma.action_otps.count({ where: { org_id: orgId, user_id: user.id, created_at: { gte: new Date(Date.now() - 3_600_000) } } });
  if (recent >= MAX_PER_HOUR) throw new ApiError(429, "Too many codes requested. Try again in an hour.");
  // A new request replaces any pending one for the same purpose
  await prisma.action_otps.updateMany({ where: { org_id: orgId, user_id: user.id, purpose, used_at: null }, data: { used_at: new Date() } });

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await prisma.action_otps.create({
    data: { org_id: orgId, user_id: user.id, purpose, code_hash: "pending", payload: encrypt(JSON.stringify(payload)), expires_at: new Date(Date.now() + TTL_MS) },
  });
  await prisma.action_otps.updateMany({ where: { id: row.id, org_id: orgId }, data: { code_hash: hashCode(row.id, code) } });

  try {
    const html = await renderSimple("Your confirmation code", [
      `Use this code to ${LABEL[purpose]}:`,
      code,
      "It expires in 10 minutes. If you did not request it, ignore this email and nothing will change.",
    ]);
    await sendSystemEmail(user.email, `Your OmniReach confirmation code: ${code}`, html);
  } catch (e) {
    await prisma.action_otps.updateMany({ where: { id: row.id, org_id: orgId }, data: { used_at: new Date() } });
    if (process.env.NODE_ENV !== "production" && !process.env.RESEND_API_KEY) console.warn(`[otp] dev code for ${user.email}: ${code}`);
    else throw e instanceof ApiError ? e : new ApiError(502, "Could not send the confirmation email. Please try again.");
  }
  return { otp_id: row.id, sent_to: maskEmail(user.email) };
}

/** Verifies the code and returns the pending payload. Burns the code on success; counts attempts on failure. */
export async function consumeOtp<T>(userId: string, orgId: string, otpId: string, code: string, purpose: OtpPurpose): Promise<T> {
  const row = await prisma.action_otps.findFirst({ where: { id: otpId, org_id: orgId, user_id: userId, purpose, used_at: null } });
  if (!row || row.expires_at < new Date()) throw new ApiError(410, "This code has expired. Request a new one.");
  if (row.attempts >= MAX_ATTEMPTS) throw new ApiError(429, "Too many wrong attempts. Request a new code.");
  const a = Buffer.from(hashCode(row.id, code.trim()));
  const b = Buffer.from(row.code_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await prisma.action_otps.updateMany({ where: { id: row.id, org_id: orgId }, data: { attempts: { increment: 1 } } });
    throw new ApiError(422, "That code is not right.");
  }
  // single use: only one concurrent confirmation can flip used_at
  const claimed = await prisma.action_otps.updateMany({ where: { id: row.id, org_id: orgId, used_at: null }, data: { used_at: new Date() } });
  if (claimed.count !== 1) throw new ApiError(410, "This code was already used.");
  return JSON.parse(decrypt(row.payload)) as T;
}
