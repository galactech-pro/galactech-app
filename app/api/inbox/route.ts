import { z } from "zod";
import { withAuth, ok, parseQuery } from "@/lib/api";
import { prisma, type Prisma } from "@/lib/db";
import { backfillLegacyConversations } from "@/lib/channels/conversations";
import { pageSchema, uuid } from "../_shared/common";

const query = z.object({
  ...pageSchema,
  status: z.enum(["open", "pending", "resolved", "snoozed", "all"]).default("open"),
  /** quick filters: unread | hot | mine | unassigned */
  filter: z.enum(["all", "unread", "hot", "mine", "unassigned"]).default("all"),
  q: z.string().trim().max(100).optional(),
  channel: z.enum(["whatsapp", "email", "voice", "sms", "telegram", "instagram", "messenger", "webchat", "api"]).optional(),
  inbox_id: uuid.optional(),
});

/**
 * Conversation list (one row per contact+inbox), newest activity first. Unread = conversations.unread_count (kept by the
 * inbound pipeline, reset by POST /api/inbox/conversations/:id/read). Legacy contacts with old messages get their
 * conversation created lazily here (backfill-on-read).
 */
export const GET = withAuth(async (req, session) => {
  const q = parseQuery(req, query);
  const org = session.org_id;
  await backfillLegacyConversations(org);

  const contactWhere: Prisma.contactsWhereInput = {
    is_active: true,
    ...(q.filter === "hot" ? { lead_score: { gte: 8 } } : {}),
    // Prisma `contains` escapes LIKE wildcards (L-15)
    ...(q.q
      ? { OR: [{ full_name: { contains: q.q, mode: "insensitive" } }, { phone: { contains: q.q } }, { email: { contains: q.q, mode: "insensitive" } }] }
      : {}),
  };
  const where: Prisma.conversationsWhereInput = {
    org_id: org,
    contact: contactWhere,
    ...(q.status !== "all" ? { status: q.status } : {}),
    ...(q.filter === "unread" ? { unread_count: { gt: 0 } } : {}),
    ...(q.filter === "mine" ? { assignee_id: session.user.id } : {}),
    ...(q.filter === "unassigned" ? { assignee_id: null } : {}),
    ...(q.channel || q.inbox_id ? { inbox: { ...(q.channel ? { channel: q.channel } : {}), ...(q.inbox_id ? { id: q.inbox_id } : {}) } } : {}),
  };

  const [rows, total, statusCounts, unreadConversations] = await Promise.all([
    prisma.conversations.findMany({
      where,
      orderBy: { last_message_at: "desc" },
      skip: (q.page - 1) * q.page_size,
      take: q.page_size,
      include: {
        contact: { select: { id: true, full_name: true, phone: true, email: true, company: true, lead_score: true, status: true, assigned_to: true, tags: true, wa_opt_out: true, email_opt_out: true } },
        inbox: { select: { id: true, channel: true, name: true } },
      },
    }),
    prisma.conversations.count({ where }),
    prisma.conversations.groupBy({ by: ["status"], where: { org_id: org, contact: { is_active: true } }, _count: { _all: true } }),
    prisma.conversations.count({ where: { org_id: org, contact: { is_active: true }, status: { in: ["open", "pending"] }, unread_count: { gt: 0 } } }),
  ]);

  const ids = rows.map((r) => r.id);
  const assigneeIds = [...new Set(rows.map((r) => r.assignee_id).filter((x): x is string => !!x))];
  const [lastMsgs, assignees] = await Promise.all([
    ids.length
      ? prisma.messages.findMany({
          where: { org_id: org, conversation_id: { in: ids } },
          orderBy: { created_at: "desc" },
          distinct: ["conversation_id"],
          select: { id: true, conversation_id: true, content: true, direction: true, channel: true, status: true, created_at: true },
        })
      : [],
    assigneeIds.length ? prisma.users.findMany({ where: { org_id: org, id: { in: assigneeIds } }, select: { id: true, full_name: true } }) : [],
  ]);
  const mMap = new Map(lastMsgs.map((m) => [m.conversation_id, m]));
  const aMap = new Map(assignees.map((a) => [a.id, a]));

  const items = rows.map((r) => ({
    id: r.id,
    status: r.status,
    unread: r.unread_count,
    last_at: r.last_message_at,
    last_inbound_at: r.last_inbound_at,
    contact: r.contact,
    inbox: r.inbox,
    assignee: r.assignee_id ? aMap.get(r.assignee_id) ?? null : null,
    last_message: mMap.get(r.id) ?? null,
  }));
  const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));
  return ok({
    items,
    total,
    unread_conversations: unreadConversations,
    counts: { open: counts.open ?? 0, pending: counts.pending ?? 0, resolved: counts.resolved ?? 0, snoozed: counts.snoozed ?? 0 },
    page: q.page,
    page_size: q.page_size,
  });
});
