import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundMsg {
  waMessageId: string;
  from: string; // E.164 with leading +
  phoneNumberId: string;
  type: string;
  text: string;
  timestamp: Date;
  profileName?: string;
  replyToWaId?: string;
}
export interface StatusUpdate {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: Date;
  phoneNumberId: string;
  recipient?: string;
  error?: string;
  errorCode?: string;
}

/** X-Hub-Signature-256 over the RAW body, constant-time compare. */
export function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WA_APP_SECRET;
  if (!secret || !header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time string compare (for the GET verify token). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface WaValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: {
    id: string;
    from: string;
    timestamp: string;
    type: string;
    text?: { body?: string };
    button?: { text?: string };
    interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
    image?: { caption?: string };
    document?: { caption?: string };
    context?: { id?: string };
  }[];
  statuses?: {
    id: string;
    status: string;
    timestamp: string;
    recipient_id?: string;
    errors?: { code?: number; title?: string; message?: string }[];
  }[];
}

export function parseWebhook(body: unknown): { messages: InboundMsg[]; statuses: StatusUpdate[] } {
  const out = { messages: [] as InboundMsg[], statuses: [] as StatusUpdate[] };
  const entries = (body as { entry?: { changes?: { value?: WaValue }[] }[] } | null)?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v) continue;
      const phoneNumberId = v.metadata?.phone_number_id ?? "";
      for (const m of v.messages ?? []) {
        const text =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          m.image?.caption ??
          m.document?.caption ??
          `[${m.type}]`;
        out.messages.push({
          waMessageId: m.id,
          from: `+${m.from.replace(/\D/g, "")}`,
          phoneNumberId,
          type: m.type,
          text,
          timestamp: new Date(Number(m.timestamp) * 1000),
          profileName: v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name,
          replyToWaId: m.context?.id,
        });
      }
      for (const s of v.statuses ?? []) {
        if (!["sent", "delivered", "read", "failed"].includes(s.status)) continue;
        out.statuses.push({
          waMessageId: s.id,
          status: s.status as StatusUpdate["status"],
          timestamp: new Date(Number(s.timestamp) * 1000),
          phoneNumberId,
          recipient: s.recipient_id,
          error: s.errors?.[0] ? `${s.errors[0].title ?? ""} ${s.errors[0].message ?? ""}`.trim() : undefined,
          errorCode: s.errors?.[0]?.code !== undefined ? String(s.errors[0].code) : undefined,
        });
      }
    }
  }
  return out;
}

const OPT_OUT = new Set(["stop", "unsubscribe", "cancel", "optout", "opt out", "opt-out", "stop all"]);
const extraKeywords = () =>
  (process.env.OPT_OUT_KEYWORDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * STOP detection (M-05). Exact keywords (plus env OPT_OUT_KEYWORDS, comma separated, e.g. regional-language words)
 * or a SHORT message (<= 6 words) containing stop / unsubscribe / opt out as a whole word ("please stop messaging me").
 * "cancel" alone only counts as an exact match so "cancel my order" is not treated as an opt-out.
 */
export function isOptOutKeyword(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (OPT_OUT.has(t) || extraKeywords().includes(t)) return true;
  if (t.split(/\s+/).length > 6) return false;
  return /\b(stop|unsubscribe|opt[\s-]?out)\b/.test(t);
}
