export type Outcome = "interested" | "callback" | "not_interested" | "no_answer" | "voicemail";

export interface VoiceCall {
  id: string;
  contact_id: string;
  to_number: string;
  status: string;
  duration_seconds: number | null;
  transcript: string | null;
  summary: string | null;
  outcome: Outcome | null;
  recording_url: string | null;
  cost_inr: string | null;
  scheduled_at: string | null;
  created_at: string;
  contact: { id: string; full_name: string; phone: string };
}

export interface VoiceStats {
  total_calls: number;
  answer_rate: number;
  avg_duration_seconds: number;
  calls_this_month: number;
  calls_limit: number | null;
  cost_total_inr: string;
  cost_this_month_inr: string;
}

export interface VoiceList {
  items: VoiceCall[];
  total: number;
  page: number;
  page_size: number;
  stats: VoiceStats;
}

export function fmtDuration(s: number | null | undefined): string {
  if (!s) return "-";
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
