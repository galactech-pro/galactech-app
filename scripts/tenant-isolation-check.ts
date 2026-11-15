/**
 * Lint-ish CI check (run: `pnpm check:tenant`). Statically scans source for single-record Prisma calls
 * (findUnique / findUniqueOrThrow / update / delete / upsert) on tenant models (those with an `org_id` column in
 * prisma/schema.prisma) whose arguments never mention `org_id`. Such calls are IDOR candidates: they trust an id.
 *
 * Heuristic, text-based: it cannot follow variables, so it can miss things and can flag safe code, e.g. an update by
 * id right after an org-scoped lookup. Mark reviewed-safe calls with a `// tenant-ok: <reason>` comment on the same
 * or the previous line. Raw SQL ($queryRaw) is NOT checked here. Exits 1 and prints the list when anything is flagged.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "inngest"];
const OPS = ["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"];

function tenantModels(): Set<string> {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  const out = new Set<string>();
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    if (/^\s*org_id\s+String\b(?!\?)/m.test(m[2]) && !/^\s*org_id\s+String\?/m.test(m[2])) out.add(m[1]);
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

/** Returns the text between the parentheses that open at `start` (index of "("). */
function callArgs(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(start + 1, i);
  }
  return src.slice(start + 1);
}

const models = tenantModels();
const re = new RegExp(String.raw`\b(?:prisma|tx|db)\.(\w+)\.(${OPS.join("|")})\s*\(`, "g");
const findings: string[] = [];

for (const d of SCAN_DIRS) {
  let files: string[] = [];
  try {
    files = [...walk(join(ROOT, d))];
  } catch {
    continue;
  }
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const lines = src.split("\n");
    for (const m of src.matchAll(re)) {
      const [, model, op] = m;
      if (!models.has(model)) continue;
      const open = (m.index ?? 0) + m[0].length - 1;
      const args = callArgs(src, open);
      if (/org_id/.test(args)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const ctx = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
      if (/tenant-ok/.test(ctx) || /tenant-ok/.test(args)) continue;
      findings.push(`${relative(ROOT, f).split("\\").join("/")}:${line}  prisma.${model}.${op}(...) has no org_id in its arguments`);
    }
  }
}

if (findings.length) {
  console.error(`tenant-isolation-check: ${findings.length} call(s) without org_id (add org_id, use forOrg(), or annotate // tenant-ok: reason)\n`);
  for (const l of findings) console.error("  " + l);
  process.exit(1);
}
console.log(`tenant-isolation-check: OK (${models.size} tenant models scanned)`);
