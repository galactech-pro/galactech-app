import { PrismaClient } from "@prisma/client";
import { pooledDatabaseUrl } from "../lib/db-url";

// One-off helper: removes the smoke-test account (and its org via cascade). Usage: tsx scripts/cleanup-test-user.ts <email>
const p = new PrismaClient({ datasources: { db: { url: pooledDatabaseUrl() } } });
async function main() {
  const email = (process.argv[2] ?? "").toLowerCase();
  if (!email) throw new Error("email argument required");
  const u = await p.users.findUnique({ where: { email } });
  if (u) await p.organisations.delete({ where: { id: u.org_id } });
  console.log("deleted:", !!u, "| users left:", await p.users.count(), "| orgs left:", await p.organisations.count());
}
main().finally(() => p.$disconnect());
