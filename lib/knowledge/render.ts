import { join } from "node:path";
import { assertPublicUrl } from "./crawl";

/**
 * Renders JavaScript-driven pages (single-page apps that load their content after the page opens) in a headless browser and
 * returns the final HTML. Only used for pages whose plain HTML had almost no text. Safe by construction:
 *  - every request the page makes (including scripts and API calls) is checked against private network ranges and blocked if internal,
 *  - images, media and fonts are not loaded, and each page and the whole run have hard time limits,
 *  - any failure returns what was rendered so far, never throws: the caller keeps the page as "unreadable" in its report.
 */

/** The browser files are shipped with the function (copied to ./vendor/chromium-bin at build time). */
const CHROMIUM_DIR = join(process.cwd(), "vendor", "chromium-bin");
const PAGE_TIMEOUT_MS = 15_000;
const RUN_BUDGET_MS = 45_000;
export const MAX_RENDERED_PAGES = 6;

export async function renderPages(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!urls.length) return out;
  const started = Date.now();
  let browser: import("puppeteer-core").Browser | null = null;
  try {
    // Vercel may report a newer Node than the browser package knows; it only unpacks its bundled system libraries for 20/22
    if (!process.env.CHROME_PATH && !/nodejs(20|22)/.test(process.env.AWS_EXECUTION_ENV ?? "")) process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs22.x";
    const [{ default: puppeteer }, { default: chromium }] = await Promise.all([import("puppeteer-core"), import("@sparticuz/chromium")]);
    const executablePath = process.env.CHROME_PATH || (await chromium.executablePath(CHROMIUM_DIR));
    browser = await puppeteer.launch({
      executablePath,
      args: process.env.CHROME_PATH ? ["--no-sandbox", "--disable-gpu"] : chromium.args,
      headless: true,
      defaultViewport: { width: 1280, height: 900 },
    });
    const hostOk = new Map<string, Promise<boolean>>();
    const allowHost = (u: URL) => {
      const key = u.protocol + "//" + u.host;
      let p = hostOk.get(key);
      if (!p) {
        p = assertPublicUrl(u.toString()).then(() => true, () => false);
        hostOk.set(key, p);
      }
      return p;
    };
    for (const url of urls.slice(0, MAX_RENDERED_PAGES)) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      const page = await browser.newPage();
      try {
        await page.setUserAgent("OmniReachBot/1.0 (+https://galactech.pro)");
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          void (async () => {
            try {
              const type = req.resourceType();
              if (["image", "media", "font"].includes(type)) return void req.abort();
              const u = new URL(req.url());
              if (u.protocol === "data:" || u.protocol === "blob:") return void req.continue();
              if (!/^https?:$/.test(u.protocol) || !(await allowHost(u))) return void req.abort();
              return void req.continue();
            } catch {
              try { await req.abort(); } catch { /* already handled */ }
            }
          })();
        });
        await page.goto(url, { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT_MS }).catch(() => undefined); // keep whatever rendered
        await new Promise((r) => setTimeout(r, 1200)); // let late client-side rendering finish
        out.set(url, await page.content());
      } catch {
        /* this page could not be rendered */
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } catch (e) {
    console.error("[render] unavailable", e instanceof Error ? e.message : e);
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return out;
}
