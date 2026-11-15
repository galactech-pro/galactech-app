import { z } from "zod";
import { withAuth, ok, fail, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendInviteEmail, newInviteToken } from "@/app/api/team/_invite";
import { limitOrResponse } from "@/lib/rate-limit";

export const POST = withAuth(
  async (req, session) => {
    const limited = await limitOrResponse(`team-invite:${session.org_id}`, { limit: 20, windowSec: 3600 });
    if (limited) return limited;
    const { invite_id } = await parseBody(req, z.object({ invite_id: z.string().uuid() }));
    const inv = await prisma.invites.findFirst({ where: { id: invite_id, org_id: session.org_id, accepted_at: null } });
    if (!inv) return fail("Invite not found", 404);
    const { token, hash } = newInviteToken();
    const fresh = await prisma.invites.update({
      where: { id: inv.id, org_id: session.org_id },
      data: { token: hash, expires_at: new Date(Date.now() + 7 * 86400_000) },
    });
    const sent = await sendInviteEmail(session, { email: fresh.email, role: fresh.role, token });
    await audit(session, "team.invite_resend", "invite", inv.id);
    return ok({ id: fresh.id, expires_at: fresh.expires_at, email_sent: sent });
  },
  { role: "admin" }
);
