import { PrismaClient } from "@prisma/client";
import { pooledDatabaseUrl } from "../lib/db-url";

// `pnpm doctor`: validates env + DB + Resend. Never prints secret values. Exit 1 only on BLOCKING problems.
const prod = process.env.NODE_ENV === "production";
let blocking = 0;
const ok = (m: string) => console.log(`  OK        ${m}`);
const warn = (m: string) => console.log(`  WARN      ${m}`);
const opt = (m: string) => console.log(`  OPTIONAL  ${m}`);
const bad = (m: string) => {
  blocking++;
  console.log(`  MISSING   ${m}`);
};
const has = (k: string) => !!process.env[k]?.trim();

const group = (title: string) => console.log(`\n${title}`);
const required = (k: string, why: string) => (has(k) ? ok(k) : bad(`${k} (${why})`));
const optional = (k: string, why: string) => (has(k) ? ok(k) : opt(`${k} not set: ${why}`));

async function main() {
  console.log(`OmniReach doctor (NODE_ENV=${process.env.NODE_ENV ?? "development"})`);

  group("Core");
  required("DATABASE_URL", "Postgres connection, runtime");
  required("DIRECT_URL", "Postgres connection, prisma db push");
  required("ENCRYPTION_KEY", "encrypts per-org secrets");
  const ek = process.env.ENCRYPTION_KEY ?? "";
  if (ek) (/^[0-9a-fA-F]{64}$/.test(ek) ? ok("ENCRYPTION_KEY is 64 hex chars") : bad("ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)"));
  const app = process.env.NEXT_PUBLIC_APP_URL ?? "";
  if (!app) {
    prod ? bad("NEXT_PUBLIC_APP_URL (required in production)") : warn("NEXT_PUBLIC_APP_URL not set; defaulting to http://localhost:3000");
  } else {
    try {
      const u = new URL(app);
      ok(`NEXT_PUBLIC_APP_URL = ${u.origin}`);
      if (prod && u.protocol !== "https:") bad("NEXT_PUBLIC_APP_URL must be https in production");
      if (prod && /localhost|127\.0\.0\.1/.test(u.hostname)) bad("NEXT_PUBLIC_APP_URL points at localhost in production");
      if (app.endsWith("/")) warn("NEXT_PUBLIC_APP_URL has a trailing slash (it is stripped, but tidy it)");
    } catch {
      bad("NEXT_PUBLIC_APP_URL is not a valid URL");
    }
  }
  const dbu = process.env.DATABASE_URL ?? "";
  if (dbu) {
    if (!/sslmode=require/.test(dbu)) warn("DATABASE_URL has no sslmode=require (Supabase needs TLS)");
    if (prod && /pooler\.supabase\.com:5432/.test(dbu)) warn("DATABASE_URL uses the SESSION pooler (5432) in production; on serverless use the transaction pooler: port 6543 with ?pgbouncer=true&connection_limit=1");
    if (/pooler\.supabase\.com:6543/.test(dbu) && !/pgbouncer=true/.test(dbu)) bad("DATABASE_URL uses port 6543 (transaction pooler) but lacks ?pgbouncer=true; Prisma prepared statements will fail");
    if (/db\.[a-z0-9]+\.supabase\.co/.test(dbu)) warn("DATABASE_URL is the direct host (IPv6 only on many networks); prefer the pooler host");
  }

  group("Database");
  const prisma = new PrismaClient({ datasources: { db: { url: pooledDatabaseUrl() } } });
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`select 1`;
    ok(`connected (${Date.now() - t0} ms)`);
    const rows = await prisma.$queryRaw<{ tablename: string; rowsecurity: boolean }[]>`select tablename, rowsecurity from pg_tables where schemaname='public'`;
    const names = new Set(rows.map((r) => r.tablename));
    const expected = ["organisations", "users", "user_sessions", "auth_tokens", "contacts", "messages", "inboxes", "conversations", "consents", "rate_limits", "webhook_events", "plan_limits", "org_logos"];
    const missing = expected.filter((t) => !names.has(t));
    missing.length ? bad(`tables missing: ${missing.join(", ")} (run pnpm db:push)`) : ok(`${rows.length} tables present`);
    const noRls = rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
    noRls.length ? bad(`RLS off on: ${noRls.join(", ")} (run pnpm db:rls; otherwise Supabase's public REST API can expose them)`) : ok("RLS enabled on every public table (Supabase REST locked)");
    if (names.has("plan_limits")) {
      const n = await prisma.plan_limits.count();
      n > 0 ? ok(`plan_limits seeded (${n} rows)`) : bad("plan_limits is empty (run pnpm db:seed)");
    }
  } catch (e) {
    bad(`cannot reach the database: ${(e as Error).message.split("\n").filter(Boolean).slice(-1)[0]}`);
  } finally {
    await prisma.$disconnect();
  }

  group("Email (Resend)");
  optional("EMAIL_FROM", "set to an address on a verified domain");
  if (!has("RESEND_API_KEY")) {
    opt(`RESEND_API_KEY not set: ${prod ? "NO verification/reset emails can be sent in production" : "dev auto-verifies accounts and logs links"}`);
    if (prod) bad("RESEND_API_KEY (production sign-up cannot verify emails without it)");
  } else {
    try {
      const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) {
        // Restricted "sending access" keys cannot list domains; that is still a usable key.
        const body = (await res.json().catch(() => ({}))) as { name?: string };
        body.name === "restricted_api_key" ? ok("RESEND_API_KEY is valid (sending-only key; cannot list domains)") : bad("RESEND_API_KEY was rejected by Resend");
      } else if (!res.ok) {
        warn(`Resend returned HTTP ${res.status}`);
      } else {
        const body = (await res.json()) as { data?: { name: string; status: string }[] };
        const domains = body.data ?? [];
        ok(`RESEND_API_KEY valid; ${domains.length} domain(s)`);
        for (const d of domains) console.log(`              - ${d.name}: ${d.status}`);
        const fromDomain = (process.env.EMAIL_FROM ?? "").match(/@([^>\s]+)/)?.[1]?.toLowerCase();
        if (!fromDomain) warn("EMAIL_FROM has no address; set e.g. OmniReach <hello@mail.yourdomain.com>");
        else if (fromDomain === "resend.dev") warn("EMAIL_FROM uses the resend.dev sandbox: it only delivers to your own Resend account email");
        else {
          const hit = domains.find((d) => fromDomain === d.name || fromDomain.endsWith("." + d.name));
          if (!hit) warn(`EMAIL_FROM domain "${fromDomain}" is not in your Resend account, so sends will fail. Verify it, or use onboarding@resend.dev for sandbox testing.`);
          else if (hit.status !== "verified") warn(`EMAIL_FROM domain "${fromDomain}" is "${hit.status}", not verified yet (check DNS records).`);
          else ok(`EMAIL_FROM domain ${fromDomain} is verified`);
        }
      }
    } catch (e) {
      warn(`could not reach Resend: ${(e as Error).message}`);
    }
  }

  group("Channels and providers (all optional)");
  optional("WA_APP_SECRET", "WhatsApp webhook signature (required to receive WhatsApp)");
  optional("WA_WEBHOOK_VERIFY_TOKEN", "WhatsApp webhook handshake");
  optional("META_APP_SECRET", "Instagram/Messenger webhook signature");
  optional("META_WEBHOOK_VERIFY_TOKEN", "Instagram/Messenger webhook handshake");
  optional("GEMINI_API_KEY", "AI features");
  optional("ANTHROPIC_API_KEY", "voice scripts");
  optional("VAPI_API_KEY", "AI voice");
  optional("RAZORPAY_KEY_ID", "billing");
  optional("RAZORPAY_WEBHOOK_SECRET", "billing webhooks");
  if (prod) {
    required("INNGEST_SIGNING_KEY", "background jobs reject unsigned calls in production");
    required("INNGEST_EVENT_KEY", "sending events to Inngest Cloud");
  } else {
    optional("INNGEST_SIGNING_KEY", "only needed in production");
  }

  console.log(`\n${blocking ? `${blocking} blocking problem(s).` : "No blocking problems."}`);
  process.exit(blocking ? 1 : 0);
}
main();
