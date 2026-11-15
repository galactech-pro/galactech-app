import { inngest, type Events } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { generateWeeklyInsights } from "@/lib/ai";
import { sendTransactional } from "@/lib/email";
import { appUrl, notifyOwnerEmail, notifyOwnerWhatsApp, orgOwner } from "./helpers";

const DAY = 86400000;

/** WF-005: trial ending (daily). Day 5 email, day 6 WhatsApp 20% offer, day 7 final email. */
export const wf005TrialEnding = inngest.createFunction(
  { id: "wf-005-trial-ending", retries: 2 },
  { cron: "TZ=Asia/Kolkata 0 10 * * *" },
  async ({ step }) => {
    const orgs = await step.run("find-trials", async () => {
      const now = new Date();
      const rows = await prisma.organisations.findMany({
        where: { plan: "free", trial_ends_at: { gt: now, lte: new Date(now.getTime() + 3 * DAY) }, subscriptions: { none: { status: "active" } } },
        select: { id: true, trial_ends_at: true },
      });
      return rows.map((o) => ({ id: o.id, daysLeft: Math.floor(((o.trial_ends_at as Date).getTime() - now.getTime()) / DAY) }));
    });

    let sent = 0;
    for (const o of orgs) {
      if (o.daysLeft > 2) continue;
      const day = o.daysLeft === 2 ? 5 : o.daysLeft === 1 ? 6 : 7;
      const ok = await step.run(`trial-${o.id}`, async () => {
        const owner = await orgOwner(o.id);
        if (!owner) return false;
        const name = owner.full_name ?? "there";
        if (day === 6) {
          const wa = await notifyOwnerWhatsApp(o.id, `Hi ${name}, your OmniReach trial ends tomorrow. Upgrade today and get 20% off your first month: ${appUrl()}/settings/billing`, `wf-005:trial-wa:${o.id}:${day}`);
          if (wa) return true;
          return notifyOwnerEmail(o.id, "Your trial ends tomorrow: 20% off to upgrade", [`Hi ${name}, your trial ends tomorrow. Upgrade today and get 20% off your first month.`], { label: "Claim 20% off", url: `${appUrl()}/settings/billing` });
        }
        try {
          await sendTransactional("trial_ending", owner.email, { name, day });
          return true;
        } catch (e) {
          console.error("[wf-005]", e);
          return false;
        }
      });
      if (ok) sent++;
    }
    return { checked: orgs.length, sent };
  }
);

/** WF-007: payment success. */
export const wf007PaymentSuccess = inngest.createFunction(
  { id: "wf-007-payment-success", retries: 3 },
  { event: "payment/succeeded" },
  async ({ event, step }) => {
    const d = event.data as Events["payment/succeeded"];
    await step.run("congratulate", async () => {
      const text = `Thank you! Your ${d.plan} plan is now active on OmniReach. Let's grow your business together.`;
      if (!(await notifyOwnerWhatsApp(d.org_id, text, `wf-007:${event.id}`))) {
        await notifyOwnerEmail(d.org_id, "Your plan is active", [text], { label: "Open dashboard", url: `${appUrl()}/dashboard` });
      }
    });
    await step.run("invoice-email", async () => {
      const owner = await orgOwner(d.org_id);
      if (!owner) return false;
      const inv = await prisma.invoices.findFirst({ where: { org_id: d.org_id, status: "paid" }, orderBy: { issued_at: "desc" } });
      try {
        await sendTransactional("invoice", owner.email, {
          name: owner.full_name ?? "there",
          plan: d.plan,
          amount: inv ? inv.amount_inr.toString() : undefined,
          invoice_id: inv?.razorpay_invoice_id ?? undefined,
          url: inv?.pdf_url ?? undefined,
        });
        return true;
      } catch (e) {
        console.error("[wf-007]", e);
        return false;
      }
    });
    return { ok: true };
  }
);

/** WF-008: churn prevention (weekly): orgs with no campaigns in the last 7 days. */
export const wf008ChurnPrevention = inngest.createFunction(
  { id: "wf-008-churn-prevention", retries: 2 },
  { cron: "TZ=Asia/Kolkata 0 10 * * 3" },
  async ({ step }) => {
    const orgIds = await step.run("find-inactive", async () => {
      const since = new Date(Date.now() - 7 * DAY);
      const rows = await prisma.organisations.findMany({
        where: { created_at: { lt: since }, campaigns: { none: { created_at: { gte: since } } }, parent_org_id: null },
        select: { id: true },
        take: 500,
      });
      return rows.map((r) => r.id);
    });
    let sent = 0;
    for (const id of orgIds) {
      const ok = await step.run(`churn-${id}`, () =>
        notifyOwnerEmail(
          id,
          "We miss you: launch a campaign this week",
          [
            "You have not launched a campaign in the last 7 days. Teams that message leads weekly see far better replies.",
            "Try a quick WhatsApp broadcast to your warm leads, or let AI write one for you in seconds.",
          ],
          { label: "Create a campaign", url: `${appUrl()}/campaigns` }
        )
      );
      if (ok) sent++;
    }
    return { inactive: orgIds.length, sent };
  }
);

/** WF-009: weekly report, Mondays 09:00 IST. */
export const wf009WeeklyReport = inngest.createFunction(
  { id: "wf-009-weekly-report", retries: 2 },
  { cron: "TZ=Asia/Kolkata 0 9 * * 1" },
  async ({ step }) => {
    const orgIds = await step.run("find-orgs", async () => {
      const rows = await prisma.organisations.findMany({ where: { users: { some: { is_active: true } } }, select: { id: true }, take: 1000 });
      return rows.map((r) => r.id);
    });
    let sent = 0;
    for (const id of orgIds) {
      const ok = await step.run(`report-${id}`, async () => {
        try {
          const since = new Date(Date.now() - 7 * DAY);
          const [sentMsgs, delivered, read, replies, newContacts, calls, interested, dealsWon, hot] = await Promise.all([
            prisma.messages.count({ where: { org_id: id, direction: "outbound", created_at: { gte: since }, status: { not: "failed" } } }),
            prisma.messages.count({ where: { org_id: id, direction: "outbound", created_at: { gte: since }, status: { in: ["delivered", "read"] } } }),
            prisma.messages.count({ where: { org_id: id, direction: "outbound", created_at: { gte: since }, status: "read" } }),
            prisma.messages.count({ where: { org_id: id, direction: "inbound", created_at: { gte: since } } }),
            prisma.contacts.count({ where: { org_id: id, created_at: { gte: since } } }),
            prisma.ai_calls.count({ where: { org_id: id, created_at: { gte: since } } }),
            prisma.ai_calls.count({ where: { org_id: id, created_at: { gte: since }, outcome: "interested" } }),
            prisma.deals.count({ where: { org_id: id, stage: "won", closed_at: { gte: since } } }),
            prisma.contacts.count({ where: { org_id: id, lead_score: { gte: 8 }, is_active: true } }),
          ]);
          if (sentMsgs + replies + newContacts + calls === 0) return false;
          const stats = { period: "last 7 days", messages_sent: sentMsgs, delivered, read, replies, new_contacts: newContacts, ai_calls: calls, calls_interested: interested, deals_won: dealsWon, hot_leads_total: hot };
          const insights = await generateWeeklyInsights(stats);
          const lines = [
            `Messages sent: ${sentMsgs} (delivered ${delivered}, read ${read}). Replies: ${replies}.`,
            `New contacts: ${newContacts}. AI calls: ${calls} (${interested} interested). Deals won: ${dealsWon}. Hot leads: ${hot}.`,
            ...insights.split("\n").filter((l) => l.trim()),
          ];
          return notifyOwnerEmail(id, "Your weekly OmniReach report", lines, { label: "View analytics", url: `${appUrl()}/analytics` });
        } catch (e) {
          console.error("[wf-009]", id, e);
          return false;
        }
      });
      if (ok) sent++;
    }
    return { orgs: orgIds.length, sent };
  }
);

/** WF-010: agency sub-client provisioning. */
export const wf010SubClient = inngest.createFunction(
  { id: "wf-010-agency-subclient", retries: 2 },
  { event: "org/subclient.created" },
  async ({ event, step }) => {
    const d = event.data as Events["org/subclient.created"];
    await step.run("inherit-settings", async () => {
      const [parent, child] = await Promise.all([
        prisma.organisations.findUnique({ where: { id: d.parent_org_id } }),
        prisma.organisations.findUnique({ where: { id: d.org_id } }),
      ]);
      if (!parent || !child || child.parent_org_id !== parent.id) return false;
      await prisma.organisations.update({
        where: { id: child.id },
        data: {
          timezone: parent.timezone,
          language: parent.language,
          elevenlabs_voice_id: child.elevenlabs_voice_id ?? parent.elevenlabs_voice_id,
          white_label: parent.white_label,
          custom_domain: child.custom_domain,
        },
      });
      return true;
    });
    await step.run("notify-parent", async () => {
      const child = await prisma.organisations.findUnique({ where: { id: d.org_id }, select: { name: true } });
      return notifyOwnerEmail(d.parent_org_id, `Sub-client created: ${child?.name ?? "new client"}`, [`Your new sub-client workspace "${child?.name ?? ""}" is ready. Connect their WhatsApp number and import contacts to get started.`], { label: "Open clients", url: `${appUrl()}/settings` });
    });
    await step.run("welcome-child-owner", async () => {
      const owner = await orgOwner(d.org_id);
      if (!owner) return false;
      try {
        await sendTransactional("welcome", owner.email, { name: owner.full_name ?? "there" });
        return true;
      } catch {
        return false;
      }
    });
    return { ok: true };
  }
);
