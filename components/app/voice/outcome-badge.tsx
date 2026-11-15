import { Badge } from "@/components/ui/badge";
import type { Outcome } from "./types";

const MAP: Record<Outcome, { label: string; cls: string }> = {
  interested: { label: "Interested", cls: "border-transparent bg-green-100 text-green-800" },
  callback: { label: "Callback", cls: "border-transparent bg-blue-100 text-blue-800" },
  not_interested: { label: "Not interested", cls: "border-transparent bg-red-100 text-red-800" },
  no_answer: { label: "No answer", cls: "border-transparent bg-gray-100 text-gray-600" },
  voicemail: { label: "Voicemail", cls: "border-transparent bg-gray-100 text-gray-600" },
};

export function OutcomeBadge({ outcome, status }: { outcome: Outcome | null; status?: string }) {
  if (!outcome) return <Badge variant="muted">{status ? status.replace("_", " ") : "pending"}</Badge>;
  const m = MAP[outcome];
  return <Badge className={m.cls}>{m.label}</Badge>;
}
