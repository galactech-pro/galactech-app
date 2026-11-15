import { prisma } from "@/lib/db";
import { checkLimit } from "@/lib/limits";
import { audit } from "@/lib/audit";

type Invite = NonNullable<Awaited<ReturnType<typeof prisma.invites.findFirst>>>;

/**
 * Creates the invitee's account inside the inviting org and marks the invite accepted. Caller must already have verified
 * that the invite is pending + unexpired and its email matches `input.email`. Holding the invite token (delivered to that
 * inbox) proves control of the address, so the email is marked verified.
 * Throws PlanLimitError (via checkLimit) when the org has no free seat, Error("EMAIL_TAKEN") or Error("INVITE_ALREADY_USED").
 */
export async function acceptInviteForNewUser(input: { email: string; fullName: string | null; passwordHash: string }, invite: Invite) {
  await checkLimit(invite.org_id, "team_seats"); // M-08: re-check the seat at accept time
  // tenant-ok: signup lookup by globally-unique email
  if (await prisma.users.findUnique({ where: { email: input.email }, select: { id: true } })) throw new Error("EMAIL_TAKEN");
  const user = await prisma.$transaction(async (tx) => {
    // single-use: only the request that flips accepted_at wins
    const claimed = await tx.invites.updateMany({ where: { id: invite.id, org_id: invite.org_id, accepted_at: null }, data: { accepted_at: new Date() } });
    if (claimed.count !== 1) throw new Error("INVITE_ALREADY_USED");
    return tx.users.create({
      data: { org_id: invite.org_id, email: input.email, full_name: input.fullName, password_hash: input.passwordHash, email_verified_at: new Date(), role: invite.role },
    });
  });
  await audit({ org_id: invite.org_id, user: { id: user.id } }, "team.invite_accept", "user", user.id, { after: { role: invite.role } });
  return user;
}
