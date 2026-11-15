import { prisma, type Prisma } from "@/lib/db";
import type { Session } from "@/lib/auth";

/** Fire-and-forget audit trail entry. Never throws. */
export async function audit(
  session: Pick<Session, "org_id"> & { user?: { id: string } },
  action: string,
  entityType: string,
  entityId?: string | null,
  data?: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; ip?: string | null }
): Promise<void> {
  try {
    await prisma.audit_log.create({
      data: {
        org_id: session.org_id,
        user_id: session.user?.id ?? null,
        action,
        entity_type: entityType,
        entity_id: entityId ?? null,
        before: data?.before,
        after: data?.after,
        ip_address: data?.ip ?? null,
      },
    });
  } catch (e) {
    console.error("[audit] failed", e);
  }
}
