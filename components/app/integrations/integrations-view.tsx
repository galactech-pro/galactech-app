"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { ConfirmDialog } from "@/components/app/settings/confirm-dialog";
import { CopyButton } from "@/components/app/settings/connections-tab";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { api } from "@/lib/fetcher";

type Provider = "google_sheets" | "zoho" | "shopify" | "woocommerce" | "calendly" | "typeform";
interface Integration {
  provider: Provider;
  connected: boolean;
  is_active: boolean;
  last_sync_at: string | null;
  mode: "inbound_webhook" | "connect_only";
  webhook_url: string | null;
  config_keys: string[];
}
interface ConnectResult { provider: Provider; webhook_url: string | null; webhook_secret: string | null; mode: Integration["mode"] }
interface Field { key: string; label: string; placeholder?: string; secret?: boolean }

const META: Record<Provider, { name: string; blurb: string; fields: Field[]; inboundHelp?: string }> = {
  google_sheets: {
    name: "Google Sheets",
    blurb: "Link a spreadsheet for lead import and export.",
    fields: [{ key: "spreadsheet_id", label: "Spreadsheet ID" }, { key: "sheet_name", label: "Sheet name", placeholder: "Sheet1" }],
  },
  zoho: {
    name: "Zoho CRM",
    blurb: "Store Zoho CRM credentials for contact sync.",
    fields: [
      { key: "api_domain", label: "API domain", placeholder: "https://www.zohoapis.in" },
      { key: "client_id", label: "Client ID" },
      { key: "client_secret", label: "Client secret", secret: true },
      { key: "refresh_token", label: "Refresh token", secret: true },
    ],
  },
  calendly: {
    name: "Calendly",
    blurb: "Store a Calendly token for booking links.",
    fields: [{ key: "access_token", label: "Personal access token", secret: true }, { key: "booking_url", label: "Booking URL", placeholder: "https://calendly.com/you/30min" }],
  },
  typeform: {
    name: "Typeform",
    blurb: "New form responses create contacts automatically.",
    fields: [{ key: "form_id", label: "Form ID (optional)" }],
    inboundHelp: "In Typeform > Connect > Webhooks, add the URL below and paste the secret.",
  },
  shopify: {
    name: "Shopify",
    blurb: "New customers and orders create contacts automatically.",
    fields: [{ key: "shop_domain", label: "Shop domain", placeholder: "yourstore.myshopify.com" }],
    inboundHelp: "In Shopify > Settings > Notifications > Webhooks, add the URL below and use the secret to sign requests.",
  },
  woocommerce: {
    name: "WooCommerce",
    blurb: "New customers and orders create contacts automatically.",
    fields: [{ key: "store_url", label: "Store URL", placeholder: "https://yourstore.com" }],
    inboundHelp: "In WooCommerce > Settings > Advanced > Webhooks, add the URL below and set the secret.",
  },
};
const ORDER: Provider[] = ["typeform", "shopify", "woocommerce", "google_sheets", "zoho", "calendly"];

export function IntegrationsView() {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [active, setActive] = React.useState<Provider | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [reveal, setReveal] = React.useState<(ConnectResult & { name: string }) | null>(null);
  const [disc, setDisc] = React.useState<Provider | null>(null);

  const q = useQuery({ queryKey: ["integrations"], queryFn: () => api<Integration[]>("/api/integrations") });

  const connect = useMutation({
    mutationFn: (p: Provider) => {
      const config = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      return api<ConnectResult>("/api/integrations", { method: "POST", json: { provider: p, config } });
    },
    onSuccess: (r, p) => {
      qc.invalidateQueries({ queryKey: ["integrations"] });
      setActive(null);
      if (r.webhook_secret) setReveal({ ...r, name: META[p].name });
      else toast.success(`${META[p].name} connected`);
    },
    onError: (e: Error) => { if (!handleError(e)) toast.error(e.message); },
  });
  const disconnect = useMutation({
    mutationFn: (p: Provider) => api(`/api/integrations?provider=${p}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Integration disconnected");
      setDisc(null);
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openConnect(p: Provider) {
    setValues({});
    setActive(p);
  }

  const items = (q.data ?? []).slice().sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));

  return (
    <div>
      <PageHeader title="Integrations" description="Connect the tools you already use." />
      {q.isError ? (
        <div className="rounded-lg border border-destructive/30 p-6 text-sm">
          <p className="text-destructive">{(q.error as Error).message}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.isLoading
            ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)
            : items.map((it) => {
                const m = META[it.provider];
                const inbound = it.mode === "inbound_webhook";
                return (
                  <Card key={it.provider} className="flex flex-col">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="flex items-center gap-2 text-base"><Plug className="h-4 w-4" /> {m.name}</CardTitle>
                        <Badge variant={it.connected ? "success" : "muted"}>{it.connected ? "Connected" : "Not connected"}</Badge>
                      </div>
                      <CardDescription>{m.blurb}</CardDescription>
                    </CardHeader>
                    <CardContent className="mt-auto space-y-3">
                      <p className="text-xs text-muted-foreground">
                        {inbound
                          ? "Receives data via webhook. Contacts are created when the provider sends events."
                          : "Connect-only: credentials are stored securely, but no automatic sync runs yet."}
                      </p>
                      {it.connected ? (
                        <p className="text-xs text-muted-foreground">
                          Last sync: {it.last_sync_at ? new Date(it.last_sync_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never"}
                        </p>
                      ) : null}
                      {inbound && it.connected && it.webhook_url ? (
                        <div className="flex gap-2">
                          <Input readOnly value={it.webhook_url} className="h-8 text-xs" aria-label="Webhook URL" />
                          <CopyButton value={it.webhook_url} />
                        </div>
                      ) : null}
                      <div className="flex gap-2">
                        <Button size="sm" variant={it.connected ? "outline" : "default"} onClick={() => openConnect(it.provider)}>
                          {it.connected ? (inbound ? "Reconnect (new secret)" : "Update") : "Connect"}
                        </Button>
                        {it.connected ? <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDisc(it.provider)}>Disconnect</Button> : null}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
        </div>
      )}

      <Dialog open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent className="max-w-md">
          {active ? (
            <>
              <DialogHeader>
                <DialogTitle>Connect {META[active].name}</DialogTitle>
                <DialogDescription>
                  {items.find((i) => i.provider === active)?.mode === "inbound_webhook"
                    ? "We will generate a webhook URL and signing secret. The secret is shown only once."
                    : "Credentials are encrypted at rest. Saved values are never shown again."}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {META[active].fields.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`f-${f.key}`}
                      type={f.secret ? "password" : "text"}
                      autoComplete="off"
                      placeholder={f.placeholder}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setActive(null)}>Cancel</Button>
                <Button disabled={connect.isPending} onClick={() => connect.mutate(active)}>
                  {connect.isPending ? <Loader2 className="animate-spin" /> : null} Connect
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!reveal} onOpenChange={(o) => !o && setReveal(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{reveal?.name} connected</DialogTitle>
            <DialogDescription>
              Copy the signing secret now; it will not be shown again. {reveal ? META[reveal.provider].inboundHelp : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Webhook URL</Label>
              <div className="flex gap-2"><Input readOnly value={reveal?.webhook_url ?? ""} /><CopyButton value={reveal?.webhook_url ?? ""} /></div>
            </div>
            <div className="space-y-1.5">
              <Label>Secret</Label>
              <div className="flex gap-2"><Input readOnly value={reveal?.webhook_secret ?? ""} className="font-mono text-xs" /><CopyButton value={reveal?.webhook_secret ?? ""} /></div>
            </div>
          </div>
          <DialogFooter><Button onClick={() => setReveal(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!disc}
        onOpenChange={(o) => !o && setDisc(null)}
        title={`Disconnect ${disc ? META[disc].name : ""}?`}
        description="Stored credentials and the webhook secret are deleted. Existing contacts are kept."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => disc && disconnect.mutate(disc)}
      />
    </div>
  );
}
