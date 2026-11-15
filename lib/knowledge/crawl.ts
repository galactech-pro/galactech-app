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

/** Flatten schema.org JSON-LD (LocalBusiness, Organization, Product, FAQ...) into plain fact lines. Works for JS-heavy sites too. */
export function jsonLdFacts(html: string): string[] {
  const out: string[] = [];
  const push = (label: string, v: unknown) => {
    if (typeof v === "string" || typeof v === "number") {
      const t = String(v).replace(/\s+/g, " ").trim();
      if (t) out.push(`${label}: ${t.slice(0, 400)}`);
    }
  };
  const walk = (n: unknown, depth: number) => {
    if (depth > 5 || !n) return;
    if (Array.isArray(n)) {
      n.slice(0, 40).forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    const t = o["@type"];
    const type = String(Array.isArray(t) ? t[0] : t ?? "");
    if (type) {
      push("Name", o.name);
      push("About", o.description);
      push("Phone", o.telephone);
      push("Email", o.email);
      push("Price range", o.priceRange);
      const addr = o.address as Record<string, unknown> | string | undefined;
      if (typeof addr === "string") push("Address", addr);
      else if (addr && typeof addr === "object") push("Address", [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode, addr.addressCountry].filter(Boolean).join(", "));
      const hours = o.openingHours;
      push("Opening hours", Array.isArray(hours) ? hours.join("; ") : hours);
      if (/Product|Service|Offer/i.test(type)) {
        const offer = (o.offers ?? o) as Record<string, unknown>;
        if (offer && (offer.price !== undefined || offer.lowPrice !== undefined)) push(`Price of ${String(o.name ?? "item")}`, `${offer.priceCurrency ?? ""} ${offer.price ?? offer.lowPrice}`.trim());
      }
      if (type === "Question") push(`FAQ ${String(o.name ?? "")}`, (o.acceptedAnswer as Record<string, unknown> | undefined)?.text);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]!.trim()), 0);
    } catch {
      /* invalid JSON-LD: ignore */
    }
  }
  return [...new Set(out)].slice(0, 40);
}

/** Phone, email, WhatsApp and social links found anywhere in the page (header and footer included). */
export function contactLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const h = decode(m[1]!.trim());
    if (/^tel:/i.test(h)) out.add(`Phone: ${h.slice(4).trim()}`);
    else if (/^mailto:/i.test(h)) out.add(`Email: ${h.slice(7).split("?")[0]!.trim()}`);
    else if (/^https?:\/\/(wa\.me|api\.whatsapp\.com|t\.me|(www\.)?(instagram|facebook|linkedin|twitter|x|youtube)\.com)\//i.test(h)) out.add(`Link: ${h.split("?")[0]}`);
  }
  return [...out].slice(0, 20);
}

const linesOf = (html: string) =>
  decode(html)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");

export function htmlToText(html: string): { title: string; text: string; links: string[]; footer: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const links = [...html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]!);
  const meta = decode(html.match(/<meta[^>]+(?:name|property)\s*=\s*["'](?:description|og:description)["'][^>]*content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").trim();
  const body = linesOf(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  const facts = jsonLdFacts(html);
  const text = [meta.length > 20 ? meta : "", facts.join("\n"), body].filter(Boolean).join("\n");
  // Footers repeat on every page, so they are returned separately (kept once for the home page: address, hours, phone live there)
  const footerHtml = html.match(/<footer[\s\S]*?<\/footer>/i)?.[0] ?? "";
  const footer = linesOf(footerHtml.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")).slice(0, 1500);
  return { title, text, links, footer };
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

export interface Discovery {
  urls: string[];
  sitemap: string | null;
  sitemapUrls: number;
  viaLinks: boolean;
}

const locsOf = (xml: string) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1]!));

/**
 * Sitemap first (robots.txt "Sitemap:" lines, then the usual paths, following sitemap indexes), falling back to a two-level
 * link crawl from the home page when the site has none. Returns what was discovered so the screen can show it.
 */
export async function discoverPages(rootUrl: string, maxPages: number): Promise<Discovery> {
  const root = await assertPublicUrl(rootUrl);
  const found = new Set<string>();
  // Collect widely, then keep the most important pages: shallow URLs (/about, /pricing, /courses) before deep ones (/blog/2021/...)
  const COLLECT = 3000;
  const add = (u: string | null) => {
    if (u && found.size < COLLECT) found.add(u);
  };
  add(normalise(root.toString(), root));

  const candidates: string[] = [];
  const robots = await fetchText(new URL("/robots.txt", root.origin).toString(), "text/plain").catch(() => null);
  if (robots) for (const m of robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.push(m[1]!);
  for (const p of ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap-index.xml", "/sitemap/sitemap.xml"]) candidates.push(new URL(p, root.origin).toString());

  let sitemapUsed: string | null = null;
  let sitemapUrls = 0;
  const visited = new Set<string>();
  const queue = [...new Set(candidates)].slice(0, 10);
  let fetched = 0;
  while (queue.length && fetched < 12) {
    const sm = queue.shift()!;
    if (visited.has(sm)) continue;
    visited.add(sm);
    fetched++;
    const doc = await fetchText(sm, "application/xml,text/xml").catch(() => null);
    if (!doc || !/<(urlset|sitemapindex)/i.test(doc.body)) continue;
    sitemapUsed ??= sm;
    for (const l of locsOf(doc.body)) {
      if (/\.xml(\?|$)/i.test(l)) queue.push(l);
      else {
        sitemapUrls++;
        add(normalise(l, root));
      }
    }
    if (found.size >= COLLECT) break;
  }

  let viaLinks = false;
  if (found.size < Math.min(maxPages, 8)) {
    viaLinks = true;
    const home = await fetchText(root.toString()).catch(() => null);
    const level1: string[] = [];
    if (home) {
      for (const l of htmlToText(home.body).links) {
        const n = normalise(l, root);
        if (n && !found.has(n)) level1.push(n);
        add(n);
      }
    }
    for (const u of level1.slice(0, 12)) {
      if (found.size >= COLLECT) break;
      const pg = await fetchText(u).catch(() => null);
      if (pg) for (const l of htmlToText(pg.body).links) add(normalise(l, root));
    }
  }
  const depth = (u: string) => new URL(u).pathname.split("/").filter(Boolean).length;
  const home = normalise(root.toString(), root);
  const ordered = [...found].sort((a, b) => (a === home ? -1 : b === home ? 1 : depth(a) - depth(b)));
  return { urls: ordered.slice(0, maxPages), sitemap: sitemapUsed, sitemapUrls, viaLinks };
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
