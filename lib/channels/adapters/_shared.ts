import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { ChannelError } from "../types";
import type { OutboundMessage } from "../types";

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ProviderCall {
  status: number;
  json: Record<string, unknown>;
}

/**
 * ONE provider HTTP call with a timeout, classified for the outbound pipeline:
 *  - network error / timeout / 5xx -> ambiguous (the provider may have accepted it; never blind-retried)
 *  - 429                           -> retryable (definitely not accepted)
 *  - other non-2xx                 -> definitive rejection
 */
export async function providerCall(url: string, init: RequestInit, opts: { timeoutMs?: number; label: string }): Promise<ProviderCall> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (e) {
    throw new ChannelError("NETWORK", `${opts.label}: ${e instanceof Error ? e.message : "request failed"}`, { ambiguous: true });
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { status: res.status, json };
  const msg = `${opts.label}: HTTP ${res.status}`;
  if (res.status === 429) throw new ChannelError("RATE_LIMITED", msg, { retryable: true, httpStatus: 429 });
  if (res.status >= 500) throw new ChannelError("PROVIDER_5XX", msg, { ambiguous: true, httpStatus: res.status });
  throw new ChannelError("PROVIDER_REJECTED", `${msg} ${JSON.stringify(json).slice(0, 300)}`, { httpStatus: res.status });
}

export function textOf(msg: OutboundMessage): string {
  if (msg.content.kind !== "text") throw new ChannelError("UNSUPPORTED_CONTENT", `This channel only sends text (got ${msg.content.kind})`);
  return msg.content.text;
}

/**
 * Defence for channels whose opt-out is not (yet) enforced by lib/compliance.assertCanContact (it only blocks
 * wa_opt_out for whatsapp/sms). STOP scope "all" sets contacts.wa_opt_out, so a contact who opted out is never
 * messaged on telegram/instagram/messenger/webchat either. Definitive failure (no provider call).
 */
export async function assertNotOptedOut(msg: OutboundMessage): Promise<void> {
  const c = await prisma.contacts.findFirst({ where: { id: msg.contactId, org_id: msg.orgId }, select: { wa_opt_out: true, dnc: true } });
  if (!c || c.wa_opt_out || c.dnc) throw new ChannelError("OPTED_OUT", "Contact has opted out");
}

export const NO_WINDOW = { state: "n/a", outsideWindowRule: "none" } as const;
