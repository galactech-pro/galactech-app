"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/app/settings/confirm-dialog";
import { api } from "@/lib/fetcher";

interface Mailbox {
  id: string;
  email: string;
  is_active: boolean;
  needs_reconnect: boolean;
  last_polled_at: string | null;
  last_error: string | null;
}
interface Detect { detected: boolean; label?: string; help?: string }

function ago(iso: string | null): string {
  if (!iso) return "not yet";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function MailboxCard() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["mailboxes"], queryFn: () => api<Mailbox[]>("/api/mailbox") });
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [fromName, setFromName] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [adv, setAdv] = React.useState({ imap_host: "", imap_port: "993", smtp_host: "", smtp_port: "465" });
  const [det, setDet] = React.useState<Detect | null>(null);
  const [remove, setRemove] = React.useState<Mailbox | null>(null);

  const detect = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) return;
    try {
      const d = await api<Detect>("/api/mailbox/detect", { method: "POST", json: { email } });
      setDet(d);
      if (!d.detected) setAdvanced(true);
    } catch {
      /* the connect step reports real problems */
    }
  };

  const reset = () => {
    setOpen(false); setEmail(""); setPassword(""); setFromName(""); setAdvanced(false); setDet(null);
    setAdv({ imap_host: "", imap_port: "993", smtp_host: "", smtp_port: "465" });
  };

  const connect = useMutation({
    mutationFn: () => {
      const json: Record<string, unknown> = { email, password, ...(fromName.trim() ? { from_name: fromName.trim() } : {}) };
      if (advanced) {
        if (adv.imap_host.trim()) json.imap_host = adv.imap_host.trim();
        if (adv.smtp_host.trim()) json.smtp_host = adv.smtp_host.trim();
        json.imap_port = Number(adv.imap_port) || 993;
        json.smtp_port = Number(adv.smtp_port) || 465;
      }
      return api<{ email: string }>("/api/mailbox", { method: "POST", json });
    },
    onSuccess: (r) => {
      toast.success(`${r.email} connected. New mail appears in your Inbox within a few minutes.`);
      reset();
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const check = useMutation({
    mutationFn: (id: string) => api<{ imported: number; error?: string }>("/api/mailbox/poll", { method: "POST", json: { id } }),
    onSuccess: (r) => {
      if (r.error) toast.error(r.error);
      else toast.success(r.imported ? `${r.imported} new email${r.imported === 1 ? "" : "s"} imported` : "No new mail");
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/api/mailbox?id=${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Mailbox disconnected (history kept)");
      setRemove(null);
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = (list.data ?? []).filter((m) => m.is_active);

  return (
    <div className="space-y-2 border-t pt-3 text-xs">
      <p className="font-medium">Connect your own mailbox</p>
      <p className="text-muted-foreground">Read customer emails and reply from your own address, with no forwarding. Needs an app password.</p>
      {rows.map((m) => (
        <div key={m.id} className="space-y-1.5 rounded-md border p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{m.email}</span>
            <Badge variant={m.needs_reconnect || m.last_error ? "destructive" : "success"}>{m.needs_reconnect ? "Reconnect" : m.last_error ? "Problem" : "Active"}</Badge>
          </div>
          <p className="text-muted-foreground">Last checked: {ago(m.last_polled_at)}</p>
          {m.last_error ? <p className="text-destructive">{m.last_error}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7" disabled={check.isPending} onClick={() => check.mutate(m.id)}>{check.isPending && check.variables === m.id ? <Loader2 className="animate-spin" /> : null} Check now</Button>
            <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => setRemove(m)}>Disconnect</Button>
          </div>
        </div>
      ))}
      <Button size="sm" onClick={() => setOpen(true)}>{rows.length ? "Connect another mailbox" : "Connect mailbox"}</Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : reset())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect your email</DialogTitle>
            <DialogDescription>Works with Gmail, Outlook, Zoho, GoDaddy, Yahoo, iCloud and most others. The password is encrypted and never shown again.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mb-email">Email address</Label>
              <Input id="mb-email" type="email" autoComplete="off" placeholder="support@yourcompany.com" value={email} onChange={(e) => { setEmail(e.target.value); setDet(null); }} onBlur={detect} />
              {det?.detected ? <p className="text-xs text-muted-foreground">Detected: {det.label}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mb-pass">App password</Label>
              <Input id="mb-pass" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
              <p className="text-xs text-muted-foreground">{det?.detected && det.help ? det.help : "Create an app password in your email account security settings. Do not use your normal password."}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mb-name">Sender name (optional)</Label>
              <Input id="mb-name" placeholder="Acme Support" value={fromName} onChange={(e) => setFromName(e.target.value)} />
            </div>
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide server settings" : "Server settings (only if not detected)"}</button>
            {advanced ? (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1"><Label htmlFor="mb-ih">Incoming server (IMAP)</Label><Input id="mb-ih" placeholder="imap.example.com" value={adv.imap_host} onChange={(e) => setAdv((a) => ({ ...a, imap_host: e.target.value }))} /></div>
                <div className="space-y-1"><Label htmlFor="mb-ip">Port</Label><Input id="mb-ip" value={adv.imap_port} onChange={(e) => setAdv((a) => ({ ...a, imap_port: e.target.value }))} /></div>
                <div className="col-span-2 space-y-1"><Label htmlFor="mb-sh">Outgoing server (SMTP)</Label><Input id="mb-sh" placeholder="smtp.example.com" value={adv.smtp_host} onChange={(e) => setAdv((a) => ({ ...a, smtp_host: e.target.value }))} /></div>
                <div className="space-y-1"><Label htmlFor="mb-sp">Port</Label><Input id="mb-sp" value={adv.smtp_port} onChange={(e) => setAdv((a) => ({ ...a, smtp_port: e.target.value }))} /></div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={reset}>Cancel</Button>
            <Button disabled={connect.isPending || !email || !password} onClick={() => connect.mutate()}>{connect.isPending ? <Loader2 className="animate-spin" /> : null} Connect</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title="Disconnect this mailbox?"
        description="OmniReach stops reading and sending from it and deletes the saved password. Existing conversations stay."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => remove && disconnect.mutate(remove.id)}
      />
    </div>
  );
}
