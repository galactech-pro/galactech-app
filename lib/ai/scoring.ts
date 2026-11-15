/**
 * Deterministic lead-score features (audit M-12 / research 03 §3.7). PURE module.
 *
 * The number is computed here, in code, from machine-readable features. The LLM may only nudge it by
 * +/-MAX_LLM_ADJUST with a short reason (see lib/ai/index.ts scoreLead); it never produces the base score.
 */

export const SCORING_VERSION = "feat-v1";
export const MAX_LLM_ADJUST = 2;

export interface ScoreReason {
  /** Machine-readable feature code, e.g. "source", "inbound_replies". */
  code: string;
  /** Points contributed to the raw sum (can be negative). */
  points: number;
  detail: string;
}

export interface ScoreInput {
  contact: {
    email?: string | null;
    company?: string | null;
    job_title?: string | null;
    source?: string | null;
    status?: string | null;
    created_at?: Date | string | null;
    wa_opt_out?: boolean;
    email_opt_out?: boolean;
    dnc?: boolean;
  };
  messages: { direction: "inbound" | "outbound"; created_at: Date | string; opened_at?: Date | string | null; clicked_at?: Date | string | null }[];
  /** Call outcomes (most recent first or any order). */
  callOutcomes?: string[];
  /** Deal stages for this contact. */
  dealStages?: string[];
  now?: Date;
}

export interface FeatureScore {
  base: number; // integer 1..10
  raw: number;
  reasons: ScoreReason[];
  version: string;
}

/** Source quality map (0..2). Matching is by lower-cased substring; first hit wins. */
const SOURCE_POINTS: [string, number][] = [
  ["referral", 2], ["whatsapp_inbound", 2], ["inbound", 2], ["website", 2], ["form", 2], ["typeform", 2], ["webchat", 2],
  ["shopify", 1.5], ["woocommerce", 1.5], ["woo", 1.5], ["manual", 1], ["api", 1], ["import", 0], ["csv", 0],
];

const DAY = 86_400_000;
const ts = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
const r1 = (n: number) => Math.round(n * 10) / 10;

export function computeFeatureScore(i: ScoreInput): FeatureScore {
  const now = (i.now ?? new Date()).getTime();
  const reasons: ScoreReason[] = [];
  const add = (code: string, points: number, detail: string) => {
    if (points !== 0) reasons.push({ code, points: r1(points), detail });
  };
  const c = i.contact;

  const src = (c.source ?? "").toLowerCase();
  const hit = SOURCE_POINTS.find(([k]) => src.includes(k));
  add("source", hit ? hit[1] : src ? 0.5 : 0, `source=${src || "unknown"}`);

  let complete = 0;
  if (c.email) complete += 0.5;
  if (c.company) complete += 0.5;
  if (c.job_title) complete += 0.5;
  add("profile_completeness", complete, `email:${c.email ? "y" : "n"} company:${c.company ? "y" : "n"} title:${c.job_title ? "y" : "n"}`);

  const inbound = i.messages.filter((m) => m.direction === "inbound");
  const outbound = i.messages.filter((m) => m.direction === "outbound");
  const lastInbound = inbound.reduce((mx, m) => Math.max(mx, ts(m.created_at)), 0);
  if (lastInbound) {
    const days = (now - lastInbound) / DAY;
    add("recency", days <= 3 ? 1.5 : days <= 14 ? 1 : days <= 30 ? 0.5 : 0, `last_reply_days=${Math.max(0, Math.round(days))}`);
  } else if (c.created_at && (now - ts(c.created_at)) / DAY <= 7) {
    add("recency", 0.5, "new_contact_7d");
  }

  const nIn = inbound.length;
  add("inbound_replies", nIn === 0 ? 0 : nIn === 1 ? 1 : nIn <= 3 ? 2 : 3, `inbound_count=${nIn}`);
  const clicked = outbound.some((m) => m.clicked_at);
  const opened = outbound.some((m) => m.opened_at);
  add("outbound_engagement", clicked ? 1 : opened ? 0.5 : 0, `clicked=${clicked} opened=${opened}`);

  const outcomes = i.callOutcomes ?? [];
  let call = 0;
  if (outcomes.includes("interested")) call += 2.5;
  else if (outcomes.includes("callback")) call += 1.5;
  if (outcomes.includes("not_interested")) call -= 2;
  add("call_outcome", call, `outcomes=${[...new Set(outcomes)].join(",") || "none"}`);

  const stages = i.dealStages ?? [];
  const live = stages.some((s) => s !== "lost");
  add("deal_present", live ? 1.5 : 0, `deals=${stages.join(",") || "none"}`);

  if (c.status === "qualified" || c.status === "demo") add("status", 1, `status=${c.status}`);
  if (c.status === "won") add("status", 1, "status=won");
  if (c.status === "lost") add("status", -2, "status=lost");

  if (c.wa_opt_out || c.email_opt_out || c.dnc) add("opted_out", -2, "contact opted out / DNC");

  const raw = reasons.reduce((s, r) => s + r.points, 0);
  const base = Math.max(1, Math.min(10, Math.round(1 + raw * 0.65)));
  return { base, raw: r1(raw), reasons, version: SCORING_VERSION };
}

export const clampAdjust = (n: number) => Math.max(-MAX_LLM_ADJUST, Math.min(MAX_LLM_ADJUST, Math.round(Number.isFinite(n) ? n : 0)));

/** Human-readable summary of the computed features, stored in contacts.score_reason. */
export function formatReason(f: FeatureScore, adjust = 0, adjustReason = ""): string {
  const parts = f.reasons.map((r) => `${r.code} ${r.points > 0 ? "+" : ""}${r.points}`).join(", ") || "no signals";
  const llm = adjust !== 0 ? `; AI adjustment ${adjust > 0 ? "+" : ""}${adjust}: ${adjustReason}` : "";
  return `Computed ${f.base}/10 from: ${parts}${llm}`.slice(0, 500);
}
