import { inngest, type Events } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { autoReplyToMessage } from "@/lib/knowledge/reply";
import { syncSource } from "@/lib/knowledge";
import { pollMailbox } from "@/lib/mailbox/imap";

/** Every inbound customer message: answer from the knowledge base (draft or auto, per org setting). Never throws on AI trouble. */
export const kbAutoReply = inngest.createFunction(
  { id: "kb-auto-reply", retries: 1, concurrency: { limit: 5 } },
  { event: "message/inbound" },
  async ({ event, step }) => {
    const d = event.data as Events["message/inbound"];
    return step.run("answer", async () => {
      try {
        return await autoReplyToMessage(d.org_id, d.contact_id, d.message_id);
      } catch (e) {
        console.error("[kb-auto-reply]", e);
        return { action: "skipped", reason: "error" };
      }
    });
  }
);

/** Hourly: re-crawl websites whose sync interval has elapsed, so the knowledge base follows the site with no human involved. */
export const kbResync = inngest.createFunction({ id: "kb-resync", retries: 0 }, { cron: "17 * * * *" }, async ({ step }) => {
  const due = await step.run("find-due", async () => {
    const rows = await prisma.knowledge_sources.findMany({
      where: { type: "website", auto_sync: true, status: { not: "syncing" } },
      select: { id: true, org_id: true, sync_every_hours: true, last_synced_at: true },
      take: 200,
    });
    const now = Date.now();
    return rows.filter((r) => !r.last_synced_at || now - r.last_synced_at.getTime() >= r.sync_every_hours * 3_600_000).slice(0, 20);
  });
  let ok = 0;
  for (const s of due) {
    await step.run(`sync-${s.id}`, async () => {
      try {
        await syncSource(s.org_id, s.id);
        ok++;
      } catch (e) {
        console.error("[kb-resync]", s.id, e); // status/error already stored on the source
      }
    });
  }
  return { due: due.length, ok };
});

/** Every 3 minutes: pull new mail from each customer mailbox connected over IMAP into the inbox. */
export const mailboxPoll = inngest.createFunction({ id: "mailbox-poll", retries: 0, concurrency: { limit: 1 } }, { cron: "*/3 * * * *" }, async ({ step }) => {
  const ids = await step.run("find-mailboxes", async () => {
    const rows = await prisma.inboxes.findMany({ where: { channel: "email", provider: "imap", is_active: true }, select: { id: true }, take: 100 }); // tenant-ok: system job over all orgs
    return rows.map((r) => r.id);
  });
  let imported = 0;
  for (const id of ids) {
    imported += await step.run(`poll-${id}`, async () => {
      try {
        const row = await prisma.inboxes.findUnique({ where: { id } }); // tenant-ok: system job, org comes from the row
        if (!row || !row.is_active) return 0;
        return (await pollMailbox(row)).imported;
      } catch (e) {
        console.error("[mailbox-poll]", id, e);
        return 0;
      }
    });
  }
  return { mailboxes: ids.length, imported };
});
