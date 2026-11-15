import { z } from "zod";
import { withAuth, ok, fail, parseBody, parseQuery } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkLimit } from "@/lib/limits";
import { audit } from "@/lib/audit";
import { sendInviteEmail, newInviteToken } from "@/app/api/team/_invite";
import { limitOrResponse } from "@/lib/rate-limit";

export const GET = withAuth(async (_req, session) => {
  const [members, invites] = await Promise.all([
    prisma.users.findMany({
      where: { org_id: session.org_id },
      select: { id: true, email: true, full_name: true, avatar_url: true, role: true, is_active: true, last_seen_at: true, created_at: true },
      orderBy: { created_at: "asc" },
    }),
    prisma.invites.findMany({
      where: { org_id: session.org_id, accepted_at: null, expires_at: { gt: new Date() } },
      select: { id: true, email: true, role: true, expires_at: true, created_at: true },
      orderBy: { created_at: "desc" },
    }),
  ]);
  return ok({ members, invites });
});

const InviteSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
});

export const POST = withAuth(
  async (req, session) => {
    const limited = await limitOrResponse(`team-invite:${session.org_id}`, { limit: 20, windowSec: 3600 });
    if (limited) return limited;
    const b = await parseBody(req, InviteSchema);
    // M-08: pending invites also consume seats (excluding a pending invite to the same address, which is replaced below)
    const pending = await prisma.invites.count({ where: { org_id: session.org_id, accepted_at: null, expires_at: { gt: new Date() }, email: { not: b.email } } });
    await checkLimit(session.org_id, "team_seats", 1 + pending);
    const existing = await prisma.users.findFirst({ where: { email: b.email, is_active: true } });
    if (existing) return fail(existing.org_id === session.org_id ? "User is already on your team" : "That email already belongs to another organisation", 409);

    await prisma.invites.deleteMany({ where: { org_id: session.org_id, email: b.email, accepted_at: null } });
    const { token, hash } = newInviteToken();
    const invite = await prisma.invites.create({
      data: {
        org_id: session.org_id,
        email: b.email,
        role: b.role,
        token: hash, // only the sha256 hash is stored; the plaintext goes out in the email
        expires_at: new Date(Date.now() + 7 * 86400_000),
      },
    });
    const sent = await sendInviteEmail(session, { email: invite.email, role: invite.role, token });
    await audit(session, "team.invite", "invite", invite.id, { after: { email: b.email, role: b.role } });
    return ok({ id: invite.id, email: invite.email, role: invite.role, expires_at: invite.expires_at, email_sent: sent }, 201);
  },
  { role: "admin" }
);

const PatchSchema = z.object({ user_id: z.string().uuid(), role: z.enum(["admin", "member", "viewer"]) });

export const PATCH = withAuth(
  async (req, session) => {
    const b = await parseBody(req, PatchSchema);
    const target = await prisma.users.findFirst({ where: { id: b.user_id, org_id: session.org_id } });
    if (!target) return fail("User not found", 404);
    if (target.role === "owner") return fail("The owner's role cannot be changed", 403);
    const updated = await prisma.users.update({ where: { id: target.id, org_id: session.org_id }, data: { role: b.role }, select: { id: true, email: true, role: true } });
    await audit(session, "team.role_change", "user", target.id, { before: { role: target.role }, after: { role: b.role } });
    return ok(updated);
  },
  { role: "admin" }
);

const DeleteQuery = z.object({ user_id: z.string().uuid().optional(), invite_id: z.string().uuid().optional() });

/** DELETE /api/team?user_id=… (deactivate member) or ?invite_id=… (revoke invite) */
export const DELETE = withAuth(
  async (req, session) => {
    const q = parseQuery(req, DeleteQuery);
    if (q.invite_id) {
      const r = await prisma.invites.deleteMany({ where: { id: q.invite_id, org_id: session.org_id } });
      if (!r.count) return fail("Invite not found", 404);
      await audit(session, "team.invite_revoke", "invite", q.invite_id);
      return ok({ id: q.invite_id });
    }
    if (!q.user_id) return fail("user_id or invite_id is required", 422);
    const target = await prisma.users.findFirst({ where: { id: q.user_id, org_id: session.org_id } });
    if (!target) return fail("User not found", 404);
    if (target.role === "owner") return fail("The owner cannot be removed", 403);
    if (target.id === session.user.id) return fail("You cannot remove yourself", 403);
    await prisma.users.update({ where: { id: target.id, org_id: session.org_id }, data: { is_active: false } });
    await prisma.contacts.updateMany({ where: { org_id: session.org_id, assigned_to: target.id }, data: { assigned_to: null } });
    await audit(session, "team.remove", "user", target.id, { before: { email: target.email, role: target.role } });
    return ok({ id: target.id });
  },
  { role: "admin" }
);
