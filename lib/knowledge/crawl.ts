import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** SSRF-safe website fetching + text extraction. Customers paste URLs, so every hop is validated against private ranges. */

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const UA = "OmniReachBot/1.0 (+https://galactech.pro)";

function privateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224
  );
}

export function privateIp(ip: string): boolean {
  if (ip.includes(".") && !ip.includes(":")) return privateIpv4(ip);
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIpv4(mapped[1]!);
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private addresses are not allowed");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Could not resolve ${host}`);
  if (addrs.some((a) => privateIp(a.address))) throw new Error("Private addresses are not allowed");
  return u;
}

/** GET with manual redirects (max 3), each hop re-validated, size and time capped. Returns null for non-text responses. */
export async function fetchText(url: string, accept = "text/html,application/xhtml+xml,text/plain,application/xml"): Promise<{ url: string; body: string } | null> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(current);
    const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": UA, accept } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      current = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|xml|json/.test(type)) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { url: u.toString(), body: Buffer.concat(chunks).toString("utf8") };
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...", copy: "(c)", rupee: "₹" };
function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

export function htmlToText(html: string): { title: string; text: string; links: string[] } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const links = [...html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]!);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
  return { title, text, links };
}

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|mp4|mp3|css|js|json|xml|woff2?|ttf|docx?|xlsx?)(\?|$)/i;
const SKIP_PATH = /\/(cart|checkout|login|signin|signup|register|account|wp-admin|wp-login|tag|author|feed)(\/|$)/i;

function normalise(raw: string, base: URL): string | null {
  try {
    const u = new URL(raw, base);
    if (u.host !== base.host || !/^https?:$/.test(u.protocol)) return null;
    if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/$/, "") || u.origin;
  } catch {
    return null;
  }
}

/** Sitemap first (cheap, complete), falling back to following links from the home page. */
export async function discoverPages(rootUrl: string, maxPages: number): Promise<string[]> {
  const root = await assertPublicUrl(rootUrl);
  const found = new Set<string>();
  const add = (u: string | null) => {
    if (u && found.size < maxPages) found.add(u);
  };
  add(normalise(root.toString(), root));

  const sm = await fetchText(new URL("/sitemap.xml", root.origin).toString(), "application/xml,text/xml").catch(() => null);
  if (sm) {
    let locs = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!));
    const nested = locs.filter((l) => /\.xml(\?|$)/i.test(l)).slice(0, 3);
    if (nested.length) {
      locs = locs.filter((l) => !/\.xml(\?|$)/i.test(l));
      for (const n of nested) {
        const sub = await fetchText(n, "application/xml,text/xml").catch(() => null);
        if (sub) locs.push(...[...sub.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!)));
      }
    }
    for (const l of locs) add(normalise(l, root));
  }
  if (found.size < Math.min(maxPages, 5)) {
    const home = await fetchText(root.toString()).catch(() => null);
    if (home) for (const l of htmlToText(home.body).links) add(normalise(l, root));
  }
  return [...found];
}

/** Paragraph-aware chunks of ~targetChars, never splitting mid-sentence when avoidable. */
export function chunkText(text: string, targetChars = 900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > targetChars) {
      if (cur) out.push(cur), (cur = "");
      const sentences = line.match(/[^.!?।]+[.!?।]*\s*/g) ?? [line];
      let s = "";
      for (const part of sentences) {
        if ((s + part).length > targetChars && s) out.push(s.trim()), (s = "");
        s += part;
      }
      if (s.trim()) out.push(s.trim());
      continue;
    }
    if ((cur + "\n" + line).length > targetChars && cur) out.push(cur), (cur = line);
    else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.trim().length >= 40);
}
