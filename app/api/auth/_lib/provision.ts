import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

export interface ProvisionInput {
  email: string;
  passwordHash: string;
  fullName?: string | null;
  orgName?: string | null;
}

async function emailTaken(email: string): Promise<boolean> {
  // tenant-ok: signup lookup by globally-unique email
  return !!(await prisma.users.findUnique({ where: { email }, select: { id: true } }));
}

/**
 * Creates organisation (free plan, 7-day trial) + owner user + trialing subscription in ONE transaction.
 * Throws Error("EMAIL_TAKEN") when the email already has an account.
 */
export async function provisionOrgForUser(input: ProvisionInput): Promise<{ orgId: string; userId: string }> {
  if (await emailTaken(input.email)) throw new Error("EMAIL_TAKEN");

  const base = input.orgName?.trim() || (input.fullName ? `${input.fullName.trim()}'s Workspace` : `${input.email.split("@")[0]}'s Workspace`);
  const trialEnds = new Date(Date.now() + 7 * 86_400_000);

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = `${slugify(base)}-${randomBytes(3).toString("hex")}`;
    try {
      return await prisma.$transaction(async (tx) => {
        const org = await tx.organisations.create({
          data: { name: base, slug, plan: "free", trial_ends_at: trialEnds },
          select: { id: true },
        });
        const user = await tx.users.create({
          data: {
            org_id: org.id,
            email: input.email,
            password_hash: input.passwordHash,
            full_name: input.fullName?.trim() || null,
            role: "owner",
          },
          select: { id: true },
        });
        await tx.subscriptions.create({
          data: { org_id: org.id, plan: "free", status: "trialing", current_period_start: new Date(), current_period_end: trialEnds },
        });
        return { orgId: org.id, userId: user.id };
      });
    } catch (e) {
      // Slug collision -> retry; a concurrent signup with the same email -> EMAIL_TAKEN.
      if (await emailTaken(input.email)) throw new Error("EMAIL_TAKEN");
      if (attempt === 3) throw e;
    }
  }
  throw new Error("Could not provision organisation");
}
