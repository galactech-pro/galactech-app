import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";

/**
 * Tenant-scoped Prisma client: `forOrg(orgId)` returns the shared client extended so that every operation on a
 * model that has a REQUIRED `org_id` column is forced to that org:
 *  - reads / updateMany / deleteMany / count / aggregate / groupBy: `where.org_id` is overwritten with orgId
 *  - findUnique / update / delete / upsert: org_id is added to the unique `where` (Prisma 5 extended where-unique)
 *  - create / createMany: `data.org_id` is set (overwriting a client-supplied value)
 *
 * NOT covered (use explicit org_id; see scripts/tenant-isolation-check.ts):
 *  - raw SQL ($queryRaw / $executeRaw): `model` is undefined in query extensions and is never rewritten
 *  - nested relation reads/writes (include/select sub-queries, nested create/connect): only top-level args are edited,
 *    so a foreign-key id supplied by a client can still link across tenants
 *  - models without a required org_id (organisations, webhook_events, rate_limits, ...): pass-through
 *  - `create` with relation-style data (`org: { connect }`) is overwritten with org_id and Prisma rejects the mixed form
 * Basis: Prisma client-extension docs (query component) and research 01 section 4. A safety net, not a replacement for RLS.
 */
const TENANT_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === "org_id" && f.isRequired)).map((m) => m.name)
);

const WHERE_OPS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy", "updateMany", "deleteMany",
  "findUnique", "findUniqueOrThrow", "update", "delete",
]);

type Args = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown; create?: Record<string, unknown> };

export function forOrg(orgId: string) {
  if (!orgId) throw new Error("forOrg(): orgId is required");
  return prisma.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) return query(args);
          const a = { ...(args as Args) };
          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), org_id: orgId };
          } else if (operation === "create") {
            a.data = { ...(a.data as object), org_id: orgId };
          } else if (operation === "createMany" || operation === "createManyAndReturn") {
            const d = a.data as object | object[];
            a.data = Array.isArray(d) ? d.map((r) => ({ ...r, org_id: orgId })) : { ...d, org_id: orgId };
          } else if (operation === "upsert") {
            a.where = { ...(a.where ?? {}), org_id: orgId };
            a.create = { ...(a.create ?? {}), org_id: orgId };
          }
          return query(a as typeof args);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof forOrg>;

/**
 * H-01: a WhatsApp phone_number_id routes inbound webhooks to exactly one org (organisations.wa_phone_number_id is @unique).
 * Rejects when another org already holds it. The message is deliberately generic: never reveal who owns it.
 * (Ownership is NOT proven against Meta here; see docs/OPEN_QUESTIONS.md.)
 */
export async function assertPhoneNumberIdAvailable(orgId: string, phoneNumberId: string): Promise<void> {
  const taken = await prisma.organisations.findFirst({ where: { wa_phone_number_id: phoneNumberId, id: { not: orgId } }, select: { id: true } });
  if (taken) throw new ApiError(409, "This WhatsApp phone number ID cannot be connected. Check the value or contact support.");
}

/** True when a Prisma error is a unique-constraint violation (P2002). */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}
