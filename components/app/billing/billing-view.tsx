"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { ConfirmDialog } from "@/components/app/settings/confirm-dialog";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type Plan = "free" | "starter" | "growth" | "pro";
const METRICS = ["wa_messages", "emails", "ai_calls", "contacts", "team_seats", "automations"] as const;
type Metric = (typeof METRICS)[number];
const LABEL: Record<Metric, string> = {
  wa_messages: "WhatsApp messages", emails: "Emails", ai_calls: "AI calls", contacts: "Contacts", team_seats: "Team seats", automations: "Automations",
};

interface Invoice { id: string; amount_inr: string | number; currency: string; status: string; pdf_url: string | null; issued_at: string; paid_at: string | null }
interface PlanRow {
  plan: Plan;
  price_monthly_inr: number;
  price_annual_inr: number;
  features: unknown;
  limits: Record<Metric, number>;
}
interface Billing {
  plan: Plan;
  usage: { plan: Plan; trial_ends_at: string | null; metrics: Record<Metric, { used: number; limit: number }> } | null;
  trial: { ends_at: string | null; days_left: number | null; expired: boolean };
  subscription: { id: string; plan: Plan; status: string; current_period_end: string | null; cancelled_at: string | null } | null;
  invoices: Invoice[];
  plans: PlanRow[];
  razorpay_key_id: string | null;
}

interface RzInstance { open: () => void; on: (ev: string, cb: (r: unknown) => void) => void }
declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => RzInstance;
  }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
function loadRazorpay(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    const s = existing ?? document.createElement("script");
    s.addEventListener("load", () => resolve(true));
    s.addEventListener("error", () => resolve(false));
    if (!existing) {
      s.src = CHECKOUT_SRC;
      s.async = true;
      document.body.appendChild(s);
    }
  });
}

const inr = (n: number | string) => `₹${Number(n).toLocaleString("en-IN")}`;
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "-");
const RANK: Record<Plan, number> = { free: 0, starter: 1, growth: 2, pro: 3 };

function featureList(f: unknown): string[] {
  if (Array.isArray(f)) return f.filter((x): x is string => typeof x === "string");
  if (f && typeof f === "object") {
    return Object.entries(f as Record<string, unknown>)
      .filter(([, v]) => v === true || typeof v === "string" || typeof v === "number")
      .map(([k, v]) => (v === true ? k.replace(/_/g, " ") : `${k.replace(/_/g, " ")}: ${v}`));
  }
  return [];
}

export function BillingView() {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [waiting, setWaiting] = React.useState<Plan | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  React.useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const q = useQuery({ queryKey: ["billing"], queryFn: () => api<Billing>("/api/billing") });

  function pollUntilPlan(target: Plan) {
    setWaiting(target);
    let tries = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      tries += 1;
      try {
        const b = await api<Billing>("/api/billing");
        if (b.plan === target) {
          clearInterval(pollRef.current!);
          setWaiting(null);
          qc.setQueryData(["billing"], b);
          qc.invalidateQueries({ queryKey: ["settings"] });
          toast.success(`You are now on the ${target} plan`);
          return;
        }
      } catch {
        /* keep polling */
      }
      if (tries >= 20) {
        clearInterval(pollRef.current!);
        setWaiting(null);
        toast.info("Payment is processing. Your plan will update shortly; refresh in a minute.");
      }
    }, 3000);
  }

  const upgrade = useMutation({
    mutationFn: async (plan: Plan) => {
      const r = await api<{ subscription_id: string; key_id: string | null }>("/api/billing/upgrade", { method: "POST", json: { plan } });
      const key = r.key_id ?? q.data?.razorpay_key_id;
      if (!key) throw new Error("Payments are not configured");
      if (!(await loadRazorpay()) || !window.Razorpay) throw new Error("Could not load Razorpay Checkout. Check your connection and try again.");
      const rz = new window.Razorpay({
        key,
        subscription_id: r.subscription_id,
        name: "GalacTech",
        description: `${plan} plan`,
        theme: { color: "#00C16A" },
        handler: () => pollUntilPlan(plan),
        modal: { ondismiss: () => undefined },
      });
      rz.on("payment.failed", () => toast.error("Payment failed. You have not been charged for this plan."));
      rz.open();
    },
    onError: (e: Error) => { if (!handleError(e)) toast.error(e.message); },
  });

  const cancel = useMutation({
    mutationFn: () => api("/api/billing/cancel", { method: "POST" }),
    onSuccess: () => {
      toast.success("Subscription will end at the close of the billing period");
      setCancelOpen(false);
      qc.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) {
    return (
      <div>
        <PageHeader title="Billing" />
        <div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div>
        <PageHeader title="Billing" />
        <div className="rounded-lg border border-destructive/30 p-6 text-sm">
          <p className="text-destructive">{(q.error as Error | null)?.message ?? "Could not load billing."}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
        </div>
      </div>
    );
  }

  const b = q.data;
  const cancelling = !!b.subscription?.cancelled_at;
  const canCancel = !!b.subscription && b.subscription.status !== "trialing" && !cancelling;

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Your plan, usage and invoices." />

      {waiting ? (
        <div className="flex items-center gap-2 rounded-lg border bg-accent p-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Confirming your payment and activating the {waiting} plan...
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 capitalize">{b.plan} plan {b.subscription ? <Badge variant={b.subscription.status === "past_due" ? "danger" : "success"}>{b.subscription.status.replace("_", " ")}</Badge> : null}</CardTitle>
            {canCancel ? <Button variant="outline" size="sm" className="text-destructive" onClick={() => setCancelOpen(true)}>Cancel subscription</Button> : null}
          </div>
          <CardDescription>
            {b.plan === "free"
              ? b.trial.expired
                ? "Your free trial has ended. Upgrade to continue."
                : b.trial.days_left != null
                  ? `${b.trial.days_left} day${b.trial.days_left === 1 ? "" : "s"} left in your free trial (ends ${date(b.trial.ends_at)}).`
                  : "Free plan."
              : cancelling
                ? `Cancelled. Access continues until ${date(b.subscription?.current_period_end ?? null)}.`
                : b.subscription?.current_period_end
                  ? `Renews on ${date(b.subscription.current_period_end)}.`
                  : "Active."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {b.usage ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {METRICS.map((m) => {
                const { used, limit } = b.usage!.metrics[m];
                const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : used > 0 ? 100 : 0;
                const warn = pct >= 80;
                return (
                  <div key={m} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span>{LABEL[m]}</span>
                      <span className={cn("tabular-nums text-muted-foreground", warn && "font-medium text-destructive")}>
                        {used.toLocaleString("en-IN")} / {limit.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <Progress value={pct} indicatorClassName={pct >= 100 ? "bg-destructive" : warn ? "bg-yellow-500" : undefined} />
                    {warn ? <p className="text-xs text-destructive">{pct >= 100 ? "Limit reached" : "Approaching limit"}</p> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Usage is unavailable.</p>
          )}
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Plans</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {b.plans.map((p) => {
            const current = p.plan === b.plan;
            const paid = p.plan !== "free";
            const downgrade = RANK[p.plan] < RANK[b.plan];
            return (
              <Card key={p.plan} className={cn("flex flex-col", current && "border-primary ring-1 ring-primary")}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between capitalize">
                    {p.plan}
                    {current ? <Badge>Current</Badge> : null}
                  </CardTitle>
                  <CardDescription>
                    <span className="text-2xl font-semibold text-foreground">{inr(p.price_monthly_inr)}</span>/month
                    {paid ? <span className="block text-xs">Billed monthly via Razorpay</span> : null}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-between gap-4">
                  <ul className="space-y-1.5 text-sm">
                    {METRICS.map((m) => (
                      <li key={m} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span>{p.limits[m].toLocaleString("en-IN")} {LABEL[m].toLowerCase()}{m === "wa_messages" || m === "emails" || m === "ai_calls" ? "/mo" : ""}</span>
                      </li>
                    ))}
                    {featureList(p.features).map((f) => (
                      <li key={f} className="flex items-start gap-2 capitalize">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {paid ? (
                    <Button
                      variant={current ? "outline" : "default"}
                      disabled={current || downgrade || upgrade.isPending || !!waiting}
                      onClick={() => upgrade.mutate(p.plan)}
                    >
                      {upgrade.isPending && upgrade.variables === p.plan ? <Loader2 className="animate-spin" /> : null}
                      {current ? "Current plan" : downgrade ? "Contact support to downgrade" : `Upgrade to ${p.plan}`}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {b.subscription && !cancelling && b.subscription.status === "active" ? (
          <p className="mt-2 text-xs text-muted-foreground">To switch plans, cancel your current subscription first and upgrade once it ends.</p>
        ) : null}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Invoices</h2>
        <DataTable<Invoice>
          rows={b.invoices}
          rowKey={(i) => i.id}
          empty="No invoices yet."
          columns={[
            { key: "date", header: "Date", cell: (i) => date(i.issued_at) },
            { key: "amt", header: "Amount", cell: (i) => <span className="tabular-nums">{inr(i.amount_inr)}</span> },
            { key: "st", header: "Status", cell: (i) => <Badge variant={i.status === "paid" ? "success" : i.status === "failed" ? "danger" : "muted"} className="capitalize">{i.status}</Badge> },
            {
              key: "pdf",
              header: "",
              className: "text-right",
              cell: (i) => i.pdf_url ? (
                <Button asChild variant="ghost" size="sm"><a href={i.pdf_url} target="_blank" rel="noreferrer"><Download /> PDF</a></Button>
              ) : null,
            },
          ]}
        />
      </section>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel your subscription?"
        description={`You keep your ${b.plan} features until ${date(b.subscription?.current_period_end ?? null)}, then the workspace moves to the free plan and paid limits no longer apply.`}
        confirmLabel="Cancel subscription"
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}
