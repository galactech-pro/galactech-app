import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api";

/** A claim that was never marked processed is considered abandoned (worker crashed) after this long and may be re-claimed. */
const STALE_CLAIM_MS = 5 * 60_000;

/**
 * Claim a provider event. Returns true the FIRST time (caller should process), false for a duplicate.
 * Backed by webhook_events @@unique([provider, event_id]) via INSERT ... ON CONFLICT DO NOTHING (createMany skipDuplicates).
 * Flow: verify signature -> claimWebhookEvent -> process -> markProcessed (on failure: releaseWebhookEvent so the
 * provider's retry is accepted). An unprocessed claim older than 5 min is re-claimable.
 */
export async function claimWebhookEvent(provider: string, eventId: string, orgId?: string | null): Promise<boolean> {
  const { count } = await prisma.webhook_events.createMany({
    data: [{ provider, event_id: eventId, org_id: orgId ?? null }],
    skipDuplicates: true,
  });
  if (count === 1) return true;
  const reclaimed = await prisma.webhook_events.updateMany({
    where: { provider, event_id: eventId, processed_at: null, received_at: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    data: { received_at: new Date() },
  });
  return reclaimed.count === 1;
}

export async function markProcessed(provider: string, eventId: string): Promise<void> {
  await prisma.webhook_events.updateMany({ where: { provider, event_id: eventId }, data: { processed_at: new Date() } });
}

/** Drop an unprocessed claim after a handler failure so the provider's retry is not swallowed as a duplicate. */
export async function releaseWebhookEvent(provider: string, eventId: string): Promise<void> {
  await prisma.webhook_events.deleteMany({ where: { provider, event_id: eventId, processed_at: null } });
}

/**
 * Replay-window check for providers that sign a timestamp (Stripe-style / Svix-style). Throws ApiError(401) when
 * the timestamp (unix seconds) is further than `toleranceSec` from now in either direction. Only call it with a
 * timestamp that is part of the signed content; an unsigned timestamp proves nothing.
 */
export function assertFresh(timestampSec: number | string, toleranceSec = 300): void {
  const t = typeof timestampSec === "string" ? Number(timestampSec) : timestampSec;
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new ApiError(401, "Stale or invalid webhook timestamp");
}
