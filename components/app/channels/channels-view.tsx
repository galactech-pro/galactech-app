"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
import { ChannelIcon } from "@/components/app/campaigns/channel-icon";
import type { Channel } from "@/components/app/campaigns/types";
import { api } from "@/lib/fetcher";

interface InboxRow {
  id: string;
  channel: Channel;
  provider: string;
  name: string;
  identifier: string | null;
  is_active: boolean;
  needs_reconnect: boolean;
  last_inbound_at: string | null;
  webhook_url: string | null;
  snippet: string | null;
  allowed_origins?: string[];
}
interface ListData { inboxes: InboxRow[]; platform: { whatsapp: boolean; email: boolean; voice: boolean } }
interface ConnectResult { inbox_id: string; name: string; webhook_url?: string; extra_urls?: Record<string, string>; snippet?: string; notes: string[] }

type Connectable = "telegram" | "instagram" | "messenger" | "sms" | "webchat" | "api";
interface Field { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean; hint?: string }

const META: Record<Connectable, { name: string; blurb: string; status: string; beta?: boolean; steps: string[]; fields: Field[] }> = {
  telegram: {
    name: "Telegram",
    blurb: "A Telegram bot your customers can message.",
    status: "Free to set up. Customers press Start once, then you can reply any time.", beta: true,
    steps: ["Open @BotFather in Telegram and send /newbot.", "Copy the bot token it gives you and paste it below.", "We verify the token and register the webhook automatically (needs a public HTTPS app URL). Customers must press Start first."],
    fields: [{ key: "bot_token", label: "Bot token", placeholder: "123456:ABC-DEF...", secret: true }],
  },
  instagram: {
    name: "Instagram",
    blurb: "Instagram DMs for a professional account.",
    status: "Reply within 24 hours of the customer's last message. Needs a Meta app with Instagram messaging access.", beta: true,
    steps: ["Create a Meta app with the Instagram messaging product and the instagram_business_manage_messages permission.", "Generate an Instagram access token for the professional account and paste it with the account ID.", "Point the app's webhook at the callback URL shown after connecting (verify token = META_WEBHOOK_VERIFY_TOKEN on the server)."],
    fields: [
      { key: "account_id", label: "Instagram account ID", placeholder: "17841400000000000" },
      { key: "access_token", label: "Access token", secret: true },
    ],
  },
  messenger: {
    name: "Messenger",
    blurb: "Facebook Page messages.",
    status: "Reply within 24 hours of the customer's last message. Needs a Meta app with Messenger access.", beta: true,
    steps: ["Create a Meta app with the Messenger product and the pages_messaging permission.", "Generate a Page access token and paste it with the numeric Page ID (the token must belong to that Page).", "Point the app's webhook at the callback URL shown after connecting and subscribe the Page to the messages field."],
    fields: [
      { key: "account_id", label: "Page ID", placeholder: "1234567890" },
      { key: "access_token", label: "Page access token", secret: true },
    ],
  },
  sms: {
    name: "SMS (Twilio)",
    blurb: "Two-way SMS through your Twilio account.",
    status: "In India, commercial SMS needs DLT registration with your telecom provider. That is your responsibility to complete.", beta: true,
    steps: ["In Twilio, copy your Account SID and Auth Token.", "Enter a Twilio number (E.164) or a Messaging Service SID.", "After connecting, paste the incoming-message webhook URL into the Twilio number (HTTP POST)."],
    fields: [
      { key: "account_sid", label: "Account SID", placeholder: "AC..." },
      { key: "auth_token", label: "Auth token", secret: true },
      { key: "from", label: "From number", placeholder: "+14155550123", optional: true, hint: "Or use a Messaging Service SID below" },
      { key: "messaging_service_sid", label: "Messaging Service SID", placeholder: "MG...", optional: true },
    ],
  },
  webchat: {
    name: "Web chat",
    blurb: "A chat bubble for your website.",
    status: "Replies appear within a few seconds. Only the websites you list can use it.",
    steps: ["List the website origins that will host the widget (e.g. https://www.example.com).", "Paste the generated script tag before </body> on those pages."],
    fields: [
      { key: "allowed_origins", label: "Allowed origins (comma separated)", placeholder: "https://www.example.com" },
      { key: "title", label: "Widget title", placeholder: "Chat with us", optional: true },
      { key: "welcome", label: "Welcome message", placeholder: "Hi! How can we help?", optional: true },
      { key: "color", label: "Colour (hex)", placeholder: "#2563eb", optional: true },
    ],
  },
  api: {
    name: "API",
    blurb: "Push messages from any external system.",
    status: "Inbound only (no outbound callback). Requires an API key on the Pro plan.",
    steps: ["Create an API key in Settings.", "POST JSON {source_id, content, external_id?, name?, email?, phone?} to the endpoint shown after enabling. Re-posting the same external_id is ignored."],
    fields: [],
  },
};
const ORDER: Connectable[] = ["telegram", "instagram", "messenger", "sms", "webchat", "api"];

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2"><Input readOnly value={value} className="font-mono text-xs" /><CopyButton value={value} /></div>
    </div>
  );
}

export function ChannelsView() {
  const qc = useQueryClient();
  const [active, setActive] = React.useState<Connectable | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<(ConnectResult & { label: string }) | null>(null);
  const [disc, setDisc] = React.useState<InboxRow | null>(null);

  const q = useQuery({ queryKey: ["channels"], queryFn: () => api<ListData>("/api/channels") });

  const connect = useMutation({
    mutationFn: (c: Connectable) => {
      const f = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      const json: Record<string, unknown> = { channel: c, ...f };
      if (c === "webchat") json.allowed_origins = (f.allowed_origins ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return api<ConnectResult>("/api/channels", { method: "POST", json });
    },
    onSuccess: (r, c) => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setActive(null);
      setResult({ ...r, label: META[c].name });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/api/channels?id=${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Channel disconnected (history kept)");
      setDisc(null);
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = q.data;
  const byChannel = (c: Channel) => (data?.inboxes ?? []).filter((i) => i.channel === c && i.provider !== "");

  return (
    <div>
      <PageHeader title="Channels" description="Connect the places your customers message you. Connecting and disconnecting is admin-only." />
      {q.isError ? (
        <div className="rounded-xl border border-destructive/30 p-6 text-sm">
          <p className="text-destructive">{(q.error as Error).message}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
        </div>
      ) : q.isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {([
            { c: "whatsapp", name: "WhatsApp", ok: data.platform.whatsapp, blurb: "Cloud API. Managed in Settings." },
            { c: "email", name: "Email", ok: data.platform.email, blurb: "Sent through the platform email provider." },
            { c: "voice", name: "AI Voice", ok: data.platform.voice, blurb: "AI calls. Managed under AI Voice." },
          ] as const).map((p) => (
            <Card key={p.c} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base"><ChannelIcon channel={p.c} /> {p.name}</CardTitle>
                  <Badge variant={p.ok ? "success" : "muted"}>{p.ok ? "Active" : "Not connected"}</Badge>
                </div>
                <CardDescription>{p.blurb}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto">
                <Button asChild size="sm" variant="outline"><a href={p.c === "voice" ? "/voice" : "/settings"}>{p.ok ? "Manage" : "Set up"}</a></Button>
              </CardContent>
            </Card>
          ))}

          {ORDER.map((c) => {
            const m = META[c];
            const rows = byChannel(c);
            const live = rows.filter((r) => r.is_active);
            return (
              <Card key={c} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 font-display text-base"><ChannelIcon channel={c} /> {m.name}{m.beta ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Beta</span> : null}</CardTitle>
                    <Badge variant={live.length ? "success" : "muted"}>{live.length ? `${live.length} connected` : "Not connected"}</Badge>
                  </div>
                  <CardDescription>{m.blurb}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto space-y-3">
                  <p className="text-xs text-muted-foreground">{m.status}</p>
                  {rows.map((r) => (
                    <div key={r.id} className="space-y-1.5 rounded-md border p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{r.name}{r.identifier ? ` (${r.identifier})` : ""}</span>
                        <Badge variant={r.needs_reconnect ? "destructive" : r.is_active ? "success" : "muted"}>{r.needs_reconnect ? "Reconnect" : r.is_active ? "Active" : "Disconnected"}</Badge>
                      </div>
                      <p className="text-muted-foreground">Last inbound message: {fmt(r.last_inbound_at)}</p>
                      {r.is_active && r.webhook_url ? <div className="flex gap-2"><Input readOnly value={r.webhook_url} className="h-7 text-xs" aria-label="URL" /><CopyButton value={r.webhook_url} /></div> : null}
                      {r.is_active && r.snippet ? <div className="flex gap-2"><Input readOnly value={r.snippet} className="h-7 font-mono text-xs" aria-label="Widget snippet" /><CopyButton value={r.snippet} /></div> : null}
                      {r.allowed_origins?.length ? <p className="text-muted-foreground">Origins: {r.allowed_origins.join(", ")}</p> : null}
                      {r.is_active ? <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => setDisc(r)}>Disconnect</Button> : null}
                    </div>
                  ))}
                  <Button size="sm" onClick={() => { setValues({}); setActive(c); }}>{live.length ? "Add another / reconnect" : "Connect"}</Button>
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
                <DialogDescription>Credentials are encrypted at rest and never shown again.</DialogDescription>
              </DialogHeader>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">{META[active].steps.map((s) => <li key={s}>{s}</li>)}</ol>
              <div className="space-y-3">
                {META[active].fields.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <Label htmlFor={`ch-${f.key}`}>{f.label}{f.optional ? " (optional)" : ""}</Label>
                    <Input id={`ch-${f.key}`} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.placeholder} value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                    {f.hint ? <p className="text-xs text-muted-foreground">{f.hint}</p> : null}
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setActive(null)}>Cancel</Button>
                <Button disabled={connect.isPending} onClick={() => connect.mutate(active)}>{connect.isPending ? <Loader2 className="animate-spin" /> : null} Connect</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{result?.label} connected</DialogTitle>
            <DialogDescription>Copy what you need now. Secrets are never displayed again (URLs stay visible on the card).</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {result?.webhook_url ? <CopyRow label="Webhook / endpoint URL" value={result.webhook_url} /> : null}
            {Object.entries(result?.extra_urls ?? {}).map(([k, v]) => <CopyRow key={k} label={k.replace(/_/g, " ")} value={v} />)}
            {result?.snippet ? <CopyRow label="Widget snippet" value={result.snippet} /> : null}
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{result?.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
          <DialogFooter><Button onClick={() => setResult(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!disc}
        onOpenChange={(o) => !o && setDisc(null)}
        title={`Disconnect ${disc?.name ?? ""}?`}
        description="The channel stops receiving and sending. Conversations and contacts are kept."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => disc && disconnect.mutate(disc.id)}
      />
    </div>
  );
}
