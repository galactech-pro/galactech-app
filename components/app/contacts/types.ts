import * as React from "react";

export const CONTACT_STATUSES = ["new", "contacted", "qualified", "demo", "won", "lost"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export interface Assignee {
  id: string;
  full_name: string | null;
  email: string;
}

export interface Contact {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  company: string | null;
  job_title: string | null;
  source: string | null;
  tags: string[];
  lead_score: number | null;
  score_reason: string | null;
  status: ContactStatus;
  assigned_to: string | null;
  wa_opt_out: boolean;
  email_opt_out: boolean;
  dnc: boolean;
  last_contacted_at: string | null;
  created_at: string;
  assignee?: Assignee | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface TeamMember {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
}

export const STATUS_VARIANT: Record<ContactStatus, "muted" | "default" | "success" | "warning" | "danger" | "secondary"> = {
  new: "secondary",
  contacted: "muted",
  qualified: "warning",
  demo: "default",
  won: "success",
  lost: "danger",
};

export function fmtDate(v: string | Date | null | undefined, withTime = false): string {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-IN", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

export function timeAgo(v: string | Date | null | undefined): string {
  if (!v) return "never";
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(v);
}

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
