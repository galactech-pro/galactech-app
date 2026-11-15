import { prisma } from "@/lib/db";

/**
 * Run lease for the campaign worker (H-07). The schema has no "claimed" campaign status and no lease column, so the
 * lease lives inside campaigns.stats (jsonb): { run_id, run_heartbeat(ms) }. Claiming is ONE conditional UPDATE, so two
 * concurrent runs (double click, resume right after pause, duplicate event) can never both own a campaign.
 * Only raw jsonb merges (`stats || ...`) may touch stats while a run is active; never overwrite stats wholesale.
 */
const TTL_MS = () => Number(process.env.CAMPAIGN_LEASE_TTL_MS) || 10 * 60_000;

/** sending|scheduled -> sending, owned by runId. Returns false if another live run holds it or the status is not startable. */
export async function claimCampaignLease(orgId: string, campaignId: string, runId: string): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE campaigns SET
      status = 'sending'::campaign_status,
      stats = COALESCE(stats, '{}'::jsonb) || jsonb_build_object('run_id', ${runId}::text, 'run_heartbeat', (extract(epoch from now()) * 1000)::bigint)
    WHERE id = ${campaignId}::uuid AND org_id = ${orgId}::uuid AND status IN ('sending'::campaign_status, 'scheduled'::campaign_status)
      AND (
        stats->>'run_id' IS NULL OR stats->>'run_id' = ${runId}
        OR COALESCE((stats->>'run_heartbeat')::bigint, 0) < (extract(epoch from now()) * 1000)::bigint - ${TTL_MS()}::bigint
      )`;
  return n === 1;
}

/** Refresh the heartbeat; false means the lease was lost (paused, taken over) and the run must stop. */
export async function heartbeatCampaignLease(orgId: string, campaignId: string, runId: string): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE campaigns SET stats = stats || jsonb_build_object('run_heartbeat', (extract(epoch from now()) * 1000)::bigint)
    WHERE id = ${campaignId}::uuid AND org_id = ${orgId}::uuid AND stats->>'run_id' = ${runId} AND status = 'sending'::campaign_status`;
  return n === 1;
}

/** Drop any lease (pause/resume routes) so a new run can claim immediately; the old run loses its heartbeat and exits. */
export async function clearCampaignLease(orgId: string, campaignId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE campaigns SET stats = COALESCE(stats, '{}'::jsonb) - 'run_id' - 'run_heartbeat' WHERE id = ${campaignId}::uuid AND org_id = ${orgId}::uuid`;
}

/** Merge counters into stats without touching the lease. `addSkipped` is added to stats.skipped. */
export async function mergeCampaignStats(orgId: string, campaignId: string, patch: Record<string, number | string>, addSkipped = 0): Promise<void> {
  await prisma.$executeRaw`
    UPDATE campaigns SET stats = COALESCE(stats, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      || jsonb_build_object('skipped', COALESCE((stats->>'skipped')::int, 0) + ${addSkipped}::int)
    WHERE id = ${campaignId}::uuid AND org_id = ${orgId}::uuid`;
}

/**
 * Final transition, only while we still own the lease (or nobody does).
 * done=true -> 'sent' (+sent_at); done=false -> 'paused' with stopped_reason. Clears the lease.
 */
export async function finishCampaign(orgId: string, campaignId: string, runId: string, patch: Record<string, number | string>, done: boolean): Promise<void> {
  const status = done ? "sent" : "paused";
  await prisma.$executeRaw`
    UPDATE campaigns SET
      status = CASE WHEN status = 'paused'::campaign_status AND ${done}::boolean = false THEN status ELSE ${status}::campaign_status END,
      sent_at = CASE WHEN ${done}::boolean THEN (now() AT TIME ZONE 'utc') ELSE sent_at END,
      stats = (COALESCE(stats, '{}'::jsonb) - 'run_id' - 'run_heartbeat' - 'stopped_reason') || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${campaignId}::uuid AND org_id = ${orgId}::uuid AND (stats->>'run_id' = ${runId} OR stats->>'run_id' IS NULL)`;
}
