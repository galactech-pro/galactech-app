import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import type { InboxCtx } from "../types";

/**
 * Telegram Business keeps a `business_connection_id` per connected personal account. Replies must quote it, so it is
 * remembered in the (encrypted) inbox config the first time we see it (business_connection or business_message update).
 * Disabling the connection removes it, so replies fail clearly instead of going to a dead connection.
 */
export async function rememberBusinessConnection(inbox: InboxCtx, rawBody: string): Promise<void> {
  let u: { business_connection?: { id?: string; is_enabled?: boolean; can_reply?: boolean; rights?: { can_reply?: boolean } }; business_message?: { business_connection_id?: string } };
  try {
    u = JSON.parse(rawBody);
  } catch {
    return;
  }
  const current = typeof inbox.config.business_connection_id === "string" ? inbox.config.business_connection_id : "";
  let next = current;
  const bc = u.business_connection;
  if (bc?.id) next = bc.is_enabled === false ? "" : bc.id;
  else if (u.business_message?.business_connection_id) next = u.business_message.business_connection_id;
  if (next === current) return;
  const config = { ...inbox.config };
  if (next) config.business_connection_id = next;
  else delete config.business_connection_id;
  await prisma.inboxes.updateMany({ where: { id: inbox.id, org_id: inbox.org_id }, data: { config: encrypt(JSON.stringify(config)) } });
}
