import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma, type plan, type user_role } from "@/lib/db";

export interface Session {
  user: { id: string; email: string; full_name: string | null; role: user_role; email_verified: boolean };
  org_id: string;
  plan: plan;
}

/** Cookie name is also read by middleware.ts (presence check only; real validation happens here). */
export const SESSION_COOKIE = "omni_session";
const SESSION_DAYS = 30;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Creates a server-side session row and sets the httpOnly cookie. Call from a Route Handler / Server Action. */
export async function createSession(userId: string, meta: { ip?: string; userAgent?: string | null } = {}): Promise<void> {
  const jar = await cookies();
  // Rotate: a new login never reuses (or leaves alive) a session token that arrived with the request.
  const previous = jar.get(SESSION_COOKIE)?.value;
  if (previous) await prisma.user_sessions.deleteMany({ where: { token_hash: sha256(previous) } });
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.user_sessions.create({
    data: { user_id: userId, token_hash: sha256(token), expires_at: expires, ip: meta.ip ?? null, user_agent: meta.userAgent?.slice(0, 300) ?? null },
  });
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
  // Opportunistic cleanup so the table cannot grow forever. Awaited (serverless may freeze un-awaited work), and only ~2% of logins.
  if (Math.random() < 0.02) await prisma.user_sessions.deleteMany({ where: { expires_at: { lt: new Date() } } }).catch(() => undefined);
}

/** Deletes the current session row (if any) and clears the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.user_sessions.deleteMany({ where: { token_hash: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

/** Revokes every session of a user (password reset / change). */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.user_sessions.deleteMany({ where: { user_id: userId } });
}

/**
 * Resolve the signed-in user + org from the session cookie. Returns null when unauthenticated, expired or deactivated.
 * Every DB query in the app MUST be scoped by the returned org_id.
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 200) return null;

  // tenant-ok: this lookup DEFINES the tenant (keyed by the verified session token hash)
  const s = await prisma.user_sessions.findUnique({
    where: { token_hash: sha256(token) },
    include: { user: { include: { org: { select: { plan: true } } } } },
  });
  if (!s || s.expires_at < new Date() || !s.user.is_active) return null;
  const row = s.user;

  return {
    user: { id: row.id, email: row.email, full_name: row.full_name, role: row.role, email_verified: !!row.email_verified_at },
    org_id: row.org_id,
    plan: row.org.plan,
  };
}

const ROLE_RANK: Record<user_role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function hasRole(session: Session, min: user_role): boolean {
  return ROLE_RANK[session.user.role] >= ROLE_RANK[min];
}
