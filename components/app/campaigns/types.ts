export type Channel = "whatsapp" | "email" | "voice" | "sms" | "telegram" | "instagram" | "messenger" | "webchat" | "api";
export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "paused";

export interface CampaignStats {
  total?: number;
  sent?: number;
  delivered?: number;
  opened?: number;
  clicked?: number;
  replied?: number;
  converted?: number;
}

export interface Campaign {
  id: string;
  name: string;
  channel: Channel;
  type: string;
  status: CampaignStatus;
  stats: CampaignStats | null;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  content?: { body?: string; subject?: string } | null;
  audience_size?: number;
}

export interface Audience {
  all?: boolean;
  tags?: string[];
  score_min?: number;
  score_max?: number;
  status?: string[];
}

export const STATUS_BADGE: Record<CampaignStatus, "muted" | "warning" | "default" | "success" | "danger"> = {
  draft: "muted",
  scheduled: "warning",
  sending: "default",
  sent: "success",
  paused: "danger",
};

export const MERGE_TAGS = ["{name}", "{company}"] as const;
