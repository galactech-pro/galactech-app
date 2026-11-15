import { prisma } from "../lib/db";

// Plan numbers are product decisions not given in the build profile — adjust freely.
const plans = [
  { plan: "free", max_contacts: 100, max_wa_messages_mo: 100, max_emails_mo: 300, max_ai_calls_mo: 0, max_team_seats: 1, max_automations: 1, price_monthly_inr: 0, price_annual_inr: 0 },
  { plan: "starter", max_contacts: 1000, max_wa_messages_mo: 1000, max_emails_mo: 5000, max_ai_calls_mo: 0, max_team_seats: 3, max_automations: 5, price_monthly_inr: 999, price_annual_inr: 9990 },
  { plan: "growth", max_contacts: 5000, max_wa_messages_mo: 5000, max_emails_mo: 25000, max_ai_calls_mo: 100, max_team_seats: 10, max_automations: 25, price_monthly_inr: 2999, price_annual_inr: 29990 },
  { plan: "pro", max_contacts: 25000, max_wa_messages_mo: 25000, max_emails_mo: 100000, max_ai_calls_mo: 500, max_team_seats: 50, max_automations: 100, price_monthly_inr: 7999, price_annual_inr: 79990 },
] as const;

async function main() {
  for (const p of plans) {
    await prisma.plan_limits.upsert({ where: { plan: p.plan }, update: p, create: p });
  }
  console.log("Seeded plan_limits");
}

main().finally(() => prisma.$disconnect());
