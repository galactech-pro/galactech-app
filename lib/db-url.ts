/**
 * Supabase's poolers cap concurrent clients (session mode: 15 total across EVERY process: dev server, scripts, Inngest).
 * Prisma's default pool is cpus*2+1 per process, which exhausts that quickly ("EMAXCONNSESSION").
 * When DATABASE_URL points at a Supabase pooler and has no explicit connection_limit, add a small one:
 *   transaction pooler (6543): 1 per serverless instance; session pooler (5432): 4 per process (override: DB_POOL_SIZE).
 * An explicit ?connection_limit= in the URL always wins.
 */
export function pooledDatabaseUrl(raw: string | undefined = process.env.DATABASE_URL): string | undefined {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith("pooler.supabase.com") || u.searchParams.has("connection_limit")) return raw;
    const size = Number(process.env.DB_POOL_SIZE) || (u.port === "6543" ? 1 : 4);
    u.searchParams.set("connection_limit", String(size));
    return u.toString();
  } catch {
    return raw;
  }
}
