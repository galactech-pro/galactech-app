import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Session } from "@/lib/auth";
import { sendTransactional } from "@/lib/email";
import { appUrl } from "@/lib/env";

/** 32 random bytes (256 bit), base64url. Only the sha256 hex digest is stored in invites.token. */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Legacy invites stored a 48-char hex plaintext token. Accept those ONLY in that exact shape (never a 64-char hash). */
const LEGACY_TOKEN = /^[0-9a-f]{48}$/;

export async function findInviteByToken(token: string) {
  const hash = hashInviteToken(token);
  const where = LEGACY_TOKEN.test(token) ? { token: { in: [hash, token] } } : { token: hash };
  return prisma.invites.findFirst({ where });
}

/**
 * Sends the invite email (never throws). `invite.token` MUST be the plaintext token (the DB only has its hash).
 * lib/email/templates.tsx reads data.inviter / data.org / data.url, while older callers used inviter_name / org_name /
 * invite_url (audit H-02), so BOTH key sets are passed.
 */
export async function sendInviteEmail(
  session: Session,
  invite: { email: string; role: string; token: string }
): Promise<boolean> {
  try {
    const org = await prisma.organisations.findUnique({ where: { id: session.org_id }, select: { name: true } });
    const url = `${appUrl()}/signup?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email)}`;
    const inviter = session.user.full_name ?? session.user.email;
    const orgName = org?.name ?? "your team";
    await sendTransactional("invite", invite.email, {
      inviter, inviter_name: inviter,
      org: orgName, org_name: orgName,
      url, invite_url: url,
      role: invite.role,
    });
    return true;
  } catch (e) {
    console.error("[team] invite email failed", (e as Error).message);
    return false;
  }
}
