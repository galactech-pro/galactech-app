import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { ApiError } from "@/lib/api";
import { ChannelError, type InboxCtx, type OutboundContent } from "@/lib/channels/types";

/** Graph API version is configurable (env WA_GRAPH_VERSION); the default is the version this code was written against. */
const graphBase = () => `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || "v21.0"}`;
const TIMEOUT_MS = Number(process.env.WA_HTTP_TIMEOUT_MS) || 15_000;

export type WaCreds = { phoneNumberId: string; token: string; wabaId: string | null };

export const toWaPhone = (p: string) => p.replace(/\D/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Credentials stored on the legacy organisations row (token encrypted). */
export async function orgCreds(orgId: string): Promise<WaCreds> {
  const org = await prisma.organisations.findUnique({
    where: { id: orgId },
    select: { wa_phone_number_id: true, wa_access_token: true, wa_business_account_id: true },
  });
  if (!org?.wa_phone_number_id || !org.wa_access_token) throw new ApiError(400, "WhatsApp not connected");
  try {
    return { phoneNumberId: org.wa_phone_number_id, token: decrypt(org.wa_access_token), wabaId: org.wa_business_account_id };
  } catch {
    throw new ApiError(400, "WhatsApp credentials are invalid. Please reconnect WhatsApp.");
  }
}

/**
 * Inboxes created lazily from legacy org credentials carry config {source:"org"} so the token is never duplicated
 * (settings changes keep working). Inboxes connected through the channel UI carry {access_token, waba_id}.
 */
export async function inboxCreds(inbox: InboxCtx): Promise<WaCreds> {
  const cfg = inbox.config;
  if (cfg.source !== "org" && typeof cfg.access_token === "string" && cfg.access_token) {
    return { phoneNumberId: inbox.identifier, token: cfg.access_token, wabaId: typeof cfg.waba_id === "string" ? cfg.waba_id : null };
  }
  return orgCreds(inbox.org_id);
}

/** Credentials for template management: legacy org row first, else the org's first active WhatsApp inbox. */
export async function getCreds(orgId: string): Promise<WaCreds> {
  try {
    return await orgCreds(orgId);
  } catch (e) {
    const ib = await prisma.inboxes.findFirst({ where: { org_id: orgId, channel: "whatsapp", provider: "whatsapp_cloud", is_active: true } });
    if (!ib) throw e;
    const { toInboxCtx } = await import("@/lib/channels/inbox");
    return inboxCreds(toInboxCtx(ib));
  }
}

export class GraphError extends Error {
  constructor(public status: number, message: string, public transient: boolean) {
    super(message);
  }
}

/** Read/admin calls (templates): safe to retry. */
export async function graphRead(creds: WaCreds, path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
  let lastErr: GraphError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const res = await fetch(`${graphBase()}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return json;
      const err = json.error as { message?: string } | undefined;
      const transient = res.status === 429 || res.status >= 500;
      lastErr = new GraphError(res.status, err?.message ?? `WhatsApp API error ${res.status}`, transient);
      if (!transient) throw lastErr;
    } catch (e) {
      if (e instanceof GraphError) {
        if (!e.transient) throw e;
        lastErr = e;
      } else {
        lastErr = new GraphError(0, "Network error contacting WhatsApp", true);
      }
    }
  }
  throw lastErr ?? new GraphError(0, "WhatsApp request failed", true);
}

/**
 * Exactly ONE POST /messages. WhatsApp Cloud API has no idempotency key, so we must never blindly retry:
 *  - network error / timeout / 5xx  -> ambiguous (Meta may have accepted it)
 *  - 429                            -> not accepted, retryable
 *  - other 4xx                      -> definitive rejection
 * (Meta-specific error codes, e.g. the "outside window" code, are intentionally not hard-coded: UNVERIFIED.)
 */
export async function graphSend(creds: WaCreds, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${graphBase()}/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ChannelError("NETWORK", "No response from WhatsApp (timeout or network error)", { ambiguous: true });
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return json;
  const err = json.error as { message?: string; code?: number } | undefined;
  const msg = err?.message ?? `WhatsApp API error ${res.status}`;
  const code = err?.code !== undefined ? String(err.code) : String(res.status);
  if (res.status === 429) throw new ChannelError(code, msg, { retryable: true, httpStatus: 429 });
  if (res.status >= 500) throw new ChannelError(code, msg, { ambiguous: true, httpStatus: res.status });
  throw new ChannelError(code, msg, { httpStatus: res.status });
}

export function buildWaPayload(to: string, c: OutboundContent): Record<string, unknown> {
  const base = { to: toWaPhone(to) };
  switch (c.kind) {
    case "text":
      return { ...base, type: "text", text: { body: c.text, preview_url: true } };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: c.name,
          language: { code: c.language || process.env.WA_TEMPLATE_LANGUAGE || "en" },
          components: c.params?.length ? [{ type: "body", parameters: c.params.map((p) => ({ type: "text", text: p })) }] : [],
        },
      };
    case "media": {
      const m: Record<string, unknown> = { link: c.url };
      if (c.caption && c.type !== "audio") m.caption = c.caption;
      return { ...base, type: c.type, [c.type]: m };
    }
    case "interactive":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: c.body },
          action: { buttons: c.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      };
    default:
      throw new ChannelError("UNSUPPORTED_CONTENT", `WhatsApp cannot send content of kind ${c.kind}`);
  }
}
