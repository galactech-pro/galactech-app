import { Inngest } from "inngest";

/**
 * Durable background jobs, delays, retries and cron - replaces the PDF's n8n + Upstash queue.
 * Functions live in /inngest/*.ts and are served from /api/inngest.
 */
export const inngest = new Inngest({ id: "omnireach" });

/** Typed event catalogue. Send with: await sendEvent("contact/created", { org_id, contact_id }) */
export interface Events {
  "contact/created": { org_id: string; contact_id: string };
  "contact/tag.added": { org_id: string; contact_id: string; tag: string };
  "contact/score.changed": { org_id: string; contact_id: string; score: number; previous: number | null };
  "message/inbound": { org_id: string; contact_id: string; message_id: string };
  "campaign/send": { org_id: string; campaign_id: string };
  "call/ended": { org_id: string; ai_call_id: string };
  "payment/succeeded": { org_id: string; plan: string };
  "automation/trigger": { org_id: string; automation_id: string; contact_id: string; payload?: Record<string, unknown>; /** dry-run flag set only by the internal test route (never from public payloads) */ test?: boolean };
  "org/subclient.created": { parent_org_id: string; org_id: string };
}

/** Fire-and-forget; never throws (so a missing INNGEST config can't break a user request). */
export async function sendEvent<K extends keyof Events>(name: K, data: Events[K]): Promise<void> {
  try {
    await inngest.send({ name, data });
  } catch (e) {
    console.error(`[inngest] send ${name} failed`, e);
  }
}
