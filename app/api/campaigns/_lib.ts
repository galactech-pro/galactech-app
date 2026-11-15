import { z } from "zod";
import { prisma, type Prisma } from "@/lib/db";
import type { LimitMetric } from "@/lib/limits";
import { supportsOutbound } from "@/lib/channels/registry";
import { buildContactWhere, contactStatusEnum } from "../_shared/common";

const ALL_CHANNELS = ["whatsapp", "email", "voice", "sms", "telegram", "instagram", "messenger", "webchat", "api"] as const;
export type CampaignChannel = (typeof ALL_CHANNELS)[number];
/** Any channel value (filters, reads). */
export const anyChannelEnum = z.enum(ALL_CHANNELS);
/** Channels a campaign may be created for: only those with a registered adapter that supports outbound (lib/channels/registry). */
export const channelEnum = anyChannelEnum.refine((c) => supportsOutbound(c), { message: "This channel is not available for campaigns yet" });

export const audienceSchema = z
  .object({
    all: z.boolean().optional(),
    tags: z.array(z.string().min(1)).max(50).optional(),
    score_min: z.number().int().min(1).max(10).optional(),
    score_max: z.number().int().min(1).max(10).optional(),
    status: z.array(contactStatusEnum).optional(),
    contact_ids: z.array(z.string().uuid()).max(10000).optional(),
  })
  .default({ all: true });
export type AudienceFilter = z.infer<typeof audienceSchema>;

export const contentSchema = z.object({
  body: z.string().max(4096).optional(),
  subject: z.string().max(300).optional(),
  buttons: z.array(z.object({ id: z.string(), title: z.string().max(20) })).max(3).optional(),
  media_url: z.string().url().refine((u) => u.startsWith("https://"), "media_url must be https").optional(),
  media_type: z.enum(["image", "document", "video", "audio"]).optional(),
  template_name: z.string().optional(),
  template_language: z.string().max(16).optional(),
  template_params: z.array(z.string()).optional(),
});
export type CampaignContent = z.infer<typeof contentSchema>;

/** Channel-specific content rules. Returns an error message or null. */
export function validateContent(channel: CampaignChannel, c: CampaignContent): string | null {
  switch (channel) {
    case "whatsapp":
      return c.body?.trim() || c.template_name ? null : "WhatsApp campaigns need a message body or an approved template";
    case "email":
      if (!c.subject?.trim()) return "Email campaigns need a subject";
      return c.body?.trim() ? null : "Email campaigns need a body";
    case "sms":
      return c.body?.trim() ? null : "SMS campaigns need a body";
    case "voice":
      return null; // call script is generated per contact when no body is given
    default:
      return c.body?.trim() ? null : "This campaign needs a message body";
  }
}

export function metricFor(channel: CampaignChannel): LimitMetric | null {
  return channel === "whatsapp" ? "wa_messages" : channel === "email" ? "emails" : channel === "voice" ? "ai_calls" : null;
}

/** Contacts that can actually receive this channel: excludes opt-outs and DNC. */
export function audienceWhere(
  orgId: string,
  channel: CampaignChannel,
  f: AudienceFilter
): Prisma.contactsWhereInput {
  const base = buildContactWhere(orgId, {
    tags: f.tags,
    score_min: f.score_min,
    score_max: f.score_max,
    status: f.status,
    contact_ids: f.contact_ids,
  });
  const and = [...((base.AND as Prisma.contactsWhereInput[]) ?? []), { dnc: false } as Prisma.contactsWhereInput];
  if (channel === "whatsapp" || channel === "sms") and.push({ wa_opt_out: false });
  if (channel === "email") and.push({ email_opt_out: false }, { email: { not: null } });
  // Channels without a phone/email identity (telegram, instagram, ...) can only reach contacts linked to an inbox of that channel.
  if (!["whatsapp", "sms", "voice", "email"].includes(channel)) and.push({ contact_inboxes: { some: { inbox: { channel, is_active: true } } } });
  return { ...base, AND: and };
}

export async function audienceCount(orgId: string, channel: CampaignChannel, f: AudienceFilter) {
  return prisma.contacts.count({ where: audienceWhere(orgId, channel, f) });
}
