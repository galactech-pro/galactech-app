// Copies the headless browser files into ./vendor as REAL files (pnpm's symlinks make Vercel reject the deployment package).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
try {
  const pkg = dirname(require.resolve("@sparticuz/chromium/package.json"));
  const from = join(pkg, "bin");
  const to = join(process.cwd(), "vendor", "chromium-bin");
  if (!existsSync(from)) throw new Error("bin folder not found: " + from);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
  console.log("chromium files copied to vendor/chromium-bin");
} catch (e) {
  console.warn("chromium copy skipped:", e instanceof Error ? e.message : e);
}
