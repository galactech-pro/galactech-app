/**
 * Same-origin relative path guard for `next=` style parameters. Pure (safe to import in client components).
 * Rejects absolute URLs, protocol-relative `//host`, and `/\host` (browsers treat `\` as `/`).
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const u = new URL(raw, "http://x.invalid");
    if (u.origin !== "http://x.invalid") return fallback;
  } catch {
    return fallback;
  }
  return raw;
}
