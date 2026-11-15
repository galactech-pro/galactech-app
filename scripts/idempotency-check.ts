/**
 * Static idempotency check (run: `pnpm exec tsx scripts/idempotency-check.ts`). No DB, deterministic.
 * Fails if a send call in the Inngest workflows / AI drafts lacks `idempotencyKey` (or a helper's key argument).
 * Without a stable key an Inngest step retry would re-send the message.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const files = [
  ...readdirSync(join(ROOT, "inngest")).filter((f) => f.endsWith(".ts")).map((f) => join("inngest", f)),
  join("lib", "ai", "drafts.ts"),
];

// Calls that must carry an idempotencyKey inside their argument list.
const KEYED = ["sendOutbound", "sendMessage", "sendTemplate", "sendMedia", "sendInteractive", "sendEmail", "initiateCall", "routeAiOutbound"];
// Helper wrappers where the key is a positional argument; checked by arg count.
const POSITIONAL: Record<string, number> = { waToContact: 4, emailToContact: 5, notifyOwnerWhatsApp: 3, sendText: 6 };

function args(src: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", q = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { cur += c; if (c === "\\") cur += src[++i]; else if (c === q) q = ""; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if ("([{".includes(c)) { if (depth++ > 0) cur += c; continue; }
    if (")]}".includes(c)) { if (--depth === 0) { out.push(cur.trim()); return out; } cur += c; continue; }
    if (c === "," && depth === 1) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  return out;
}

const problems: string[] = [];
let checked = 0;
for (const f of files) {
  const src = readFileSync(join(ROOT, f), "utf8");
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const re = /(?<![\w.])(?:await\s+)?(\w+)\s*\(/g;
  for (const m of src.matchAll(re)) {
    const name = m[1];
    const open = m.index! + m[0].length - 1;
    const before = src.slice(Math.max(0, m.index! - 20), m.index!);
    if (/(function|async)\s*$/.test(before)) continue; // definition, not a call
    if (KEYED.includes(name)) {
      checked++;
      const a = args(src, open).join(",");
      const viaCtx = /(^|[^\w])ctx([^\w]|$)/.test(a) && /const ctx = \{[^}]*idempotencyKey/.test(src); // shared ctx object that carries the key
      if (!/idempotencyKey/.test(a) && !viaCtx) problems.push(`${f}:${lineOf(m.index!)} ${name}(...) has no idempotencyKey`);
    } else if (name in POSITIONAL) {
      checked++;
      const n = args(src, open).length;
      if (n < POSITIONAL[name]) problems.push(`${f}:${lineOf(m.index!)} ${name}(...) is missing its idempotency key argument`);
    }
  }
}

if (problems.length) {
  console.error(`idempotency-check: ${problems.length} send call(s) without a stable key\n` + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log(`idempotency-check: OK (${checked} send call(s) in ${files.length} files)`);
