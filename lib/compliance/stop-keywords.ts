/** PURE module (no DB): STOP / opt-out keyword detection. */

// ---- STOP keyword handling (M-05). Keyword list is configurable: OPT_OUT_KEYWORDS="stop,unsubscribe,..." (comma separated).
const DEFAULT_STOP = ["stop", "stop all", "unsubscribe", "opt out", "optout", "cancel", "do not contact", "dont contact", "don't contact", "remove me", "band karo", "रोको", "बंद करो"];

function stopKeywords(): string[] {
  const env = process.env.OPT_OUT_KEYWORDS;
  return env ? env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_STOP;
}

/** Short message that is (or starts/ends with) an opt-out keyword on word boundaries. Long messages are never treated as STOP. */
export function isStopKeyword(text: string): boolean {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60) return false;
  return stopKeywords().some((k) => t === k || t.startsWith(`${k} `) || t.endsWith(` ${k}`) || t.includes(` ${k} `));
}

