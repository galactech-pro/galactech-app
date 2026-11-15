import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

export type AuthTokenType = "verify_email" | "reset_password";
const TTL_MS: Record<AuthTokenType, number> = { verify_email: 24 * 3_600_000, reset_password: 60 * 60_000 };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Issues a single-use token (previous unused tokens of the same type are invalidated). Returns the raw token for the email link. */
export async function issueAuthToken(userId: string, type: AuthTokenType): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.auth_tokens.deleteMany({ where: { user_id: userId, type, used_at: null } }),
    prisma.auth_tokens.create({ data: { user_id: userId, type, token_hash: sha256(raw), expires_at: new Date(Date.now() + TTL_MS[type]) } }),
  ]);
  return raw;
}

/** Atomically consumes a token (first caller wins). Returns the user id, or null when invalid / expired / already used. */
export async function consumeAuthToken(raw: string, type: AuthTokenType): Promise<string | null> {
  if (!raw || raw.length > 200) return null;
  const hash = sha256(raw);
  const row = await prisma.auth_tokens.findUnique({ where: { token_hash: hash } });
  if (!row || row.type !== type) return null;
  const claimed = await prisma.auth_tokens.updateMany({ where: { id: row.id, used_at: null, expires_at: { gt: new Date() } }, data: { used_at: new Date() } });
  return claimed.count === 1 ? row.user_id : null;
}
