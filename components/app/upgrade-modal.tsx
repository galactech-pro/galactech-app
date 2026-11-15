"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FetchError } from "@/lib/fetcher";

export interface UpgradeInfo {
  metric?: string;
  limit?: number;
  used?: number;
  reason?: "limit" | "trial_expired";
  message?: string;
}

const METRIC_LABEL: Record<string, string> = {
  wa_messages: "WhatsApp messages",
  emails: "emails",
  ai_calls: "AI calls",
  contacts: "contacts",
  team_seats: "team seats",
  automations: "automations",
};

/** Build UpgradeInfo from a PLAN_LIMIT FetchError (message format comes from PlanLimitError). */
export function upgradeInfoFromError(e: FetchError): UpgradeInfo {
  const m = /limit for (\w+) \((\d+)\/(\d+)\)/.exec(e.message);
  const trial = /trial has ended/i.test(e.message);
  return {
    message: e.message,
    reason: trial ? "trial_expired" : "limit",
    ...(m ? { metric: m[1], used: Number(m[2]), limit: Number(m[3]) } : {}),
  };
}

export function UpgradeModal({ open, onClose, info }: { open: boolean; onClose: () => void; info?: UpgradeInfo | null }) {
  const label = info?.metric ? (METRIC_LABEL[info.metric] ?? info.metric) : null;
  const trial = info?.reason === "trial_expired";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-primary">
            <Sparkles className="h-5 w-5" />
          </div>
          <DialogTitle>{trial ? "Your free trial has ended" : "You've hit your plan limit"}</DialogTitle>
          <DialogDescription>
            {trial
              ? "Upgrade to keep sending messages, running automations and making AI calls."
              : label && info?.limit != null
                ? `Your plan includes ${info.limit.toLocaleString("en-IN")} ${label} and you've used ${(info.used ?? info.limit).toLocaleString("en-IN")}. Upgrade to unlock more.`
                : (info?.message ?? "Upgrade your plan to continue.")}
          </DialogDescription>
        </DialogHeader>
        {info?.limit != null && info.limit > 0 ? (
          <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full bg-primary" style={{ width: `${Math.min(100, ((info.used ?? info.limit) / info.limit) * 100)}%` }} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Maybe later
          </Button>
          <Button asChild onClick={onClose}>
            <Link href="/billing">View plans</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Ctx {
  show: (info?: UpgradeInfo) => void;
  /** Returns true (and opens the modal) if `e` is a PLAN_LIMIT FetchError. */
  handleError: (e: unknown) => boolean;
}
const UpgradeContext = React.createContext<Ctx | null>(null);

export function UpgradeProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = React.useState<UpgradeInfo | null>(null);
  const [open, setOpen] = React.useState(false);
  const value = React.useMemo<Ctx>(
    () => ({
      show: (i) => {
        setInfo(i ?? null);
        setOpen(true);
      },
      handleError: (e) => {
        if (e instanceof FetchError && (e.code === "PLAN_LIMIT" || e.status === 402)) {
          setInfo(upgradeInfoFromError(e));
          setOpen(true);
          return true;
        }
        return false;
      },
    }),
    []
  );
  return (
    <UpgradeContext.Provider value={value}>
      {children}
      <UpgradeModal open={open} onClose={() => setOpen(false)} info={info} />
    </UpgradeContext.Provider>
  );
}

/**
 * const { handleError } = useUpgradePrompt();
 * useMutation({ mutationFn, onError: (e) => { if (!handleError(e)) toast.error(e.message); } })
 */
export function useUpgradePrompt(): Ctx {
  const ctx = React.useContext(UpgradeContext);
  if (!ctx) {
    // Outside the dashboard shell: degrade gracefully.
    return { show: () => undefined, handleError: () => false };
  }
  return ctx;
}
