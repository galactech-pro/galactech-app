import { inngest, type Events } from "@/lib/inngest";

/**
 * Emit an Inngest event with an optional dedup id (Inngest drops events with an already-seen id within its dedup window,
 * so a retried webhook / double click cannot start the same workflow twice). Never throws; returns false on failure.
 */
export async function emitEvent<K extends keyof Events>(name: K, data: Events[K], id?: string): Promise<boolean> {
  try {
    await inngest.send({ ...(id ? { id } : {}), name, data });
    return true;
  } catch (e) {
    console.error(`[inngest] send ${name} failed`, e);
    return false;
  }
}
