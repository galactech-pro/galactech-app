"use client";

import * as React from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "./confirm-dialog";
import type { OrgSettings } from "./types";
import { useSaveSettings } from "./use-settings";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Could not copy");
        }
      }}
    >
      {done ? <Check /> : <Copy />} {label}
    </Button>
  );
}

export function WhatsAppTab({ org }: { org: OrgSettings }) {
  const w = org.whatsapp;
  const [phoneId, setPhoneId] = React.useState(w.phone_number_id ?? "");
  const [wabaId, setWabaId] = React.useState(w.business_account_id ?? "");
  const [token, setToken] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const save = useSaveSettings("WhatsApp settings saved");
  const webhook = typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/whatsapp` : "/api/webhooks/whatsapp";
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>WhatsApp Cloud API</CardTitle>
            <Badge variant={w.connected ? "success" : "muted"}>{w.connected ? "Connected" : "Not connected"}</Badge>
          </div>
          <CardDescription>Credentials from your Meta developer app (WhatsApp &gt; API Setup).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="wa-phone">Phone number ID</Label>
              <Input id="wa-phone" value={phoneId} onChange={(e) => setPhoneId(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wa-waba">WhatsApp Business Account ID</Label>
              <Input id="wa-waba" value={wabaId} onChange={(e) => setWabaId(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wa-token">Access token</Label>
            <Input
              id="wa-token"
              type="password"
              autoComplete="off"
              value={token}
              placeholder={w.access_token ? `${w.access_token} stored. Enter a new value to replace.` : "Permanent system-user token"}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  { wa_phone_number_id: phoneId.trim() || null, wa_business_account_id: wabaId.trim() || null, ...(token.trim() ? { wa_access_token: token.trim() } : {}) },
                  { onSuccess: () => setToken("") }
                )
              }
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : null} Save
            </Button>
            {w.access_token || w.phone_number_id ? (
              <Button variant="outline" className="text-destructive" onClick={() => setConfirm(true)}>Disconnect</Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Webhook setup</CardTitle>
          <CardDescription>In Meta &gt; WhatsApp &gt; Configuration, add this callback so replies and delivery receipts reach GalacTech.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label>Callback URL</Label>
            <div className="flex gap-2">
              <Input readOnly value={webhook} />
              <CopyButton value={webhook} />
            </div>
          </div>
          <p className="text-muted-foreground">
            Verify token: use the value of the <code className="rounded bg-muted px-1">WA_WEBHOOK_VERIFY_TOKEN</code> environment variable configured on the server (it is not stored per organisation). Subscribe to the <code className="rounded bg-muted px-1">messages</code> field.
          </p>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect WhatsApp?"
        description="Sending and receiving WhatsApp messages will stop until you reconnect. Existing conversations are kept."
        confirmLabel="Disconnect"
        destructive
        loading={save.isPending}
        onConfirm={() =>
          save.mutate(
            { wa_phone_number_id: null, wa_business_account_id: null, wa_access_token: null },
            { onSuccess: () => { setPhoneId(""); setWabaId(""); setToken(""); setConfirm(false); } }
          )
        }
      />
    </div>
  );
}

export function EmailTab({ org }: { org: OrgSettings }) {
  const [key, setKey] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const save = useSaveSettings("Email settings saved");
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Email (Resend)</CardTitle>
          <Badge variant={org.email.connected ? "success" : "muted"}>{org.email.connected ? "Connected" : "Not connected"}</Badge>
        </div>
        <CardDescription>Bring your own Resend API key to send campaigns from your own domain.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="rk">Resend API key</Label>
          <Input
            id="rk"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={org.email.resend_api_key ? `${org.email.resend_api_key} stored. Enter a new value to replace.` : "re_..."}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Sending domain: verify your domain (SPF, DKIM) inside the Resend dashboard. The sending domain is determined by the one verified on this key and is not configurable from GalacTech.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={save.isPending || !key.trim()} onClick={() => save.mutate({ resend_api_key: key.trim() }, { onSuccess: () => setKey("") })}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Save key
          </Button>
          {org.email.connected ? <Button variant="outline" className="text-destructive" onClick={() => setConfirm(true)}>Remove key</Button> : null}
        </div>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Remove Resend key?"
          description="Emails will fall back to the platform sender, if configured."
          confirmLabel="Remove"
          destructive
          loading={save.isPending}
          onConfirm={() => save.mutate({ resend_api_key: null }, { onSuccess: () => setConfirm(false) })}
        />
      </CardContent>
    </Card>
  );
}

export function VoiceTab({ org }: { org: OrgSettings }) {
  const [id, setId] = React.useState(org.voice.elevenlabs_voice_id ?? "");
  const save = useSaveSettings("Voice settings saved");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice agent</CardTitle>
        <CardDescription>The ElevenLabs voice used for AI calls. Paste a voice ID from ElevenLabs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="vid">ElevenLabs voice ID</Label>
          <Input id="vid" value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" />
        </div>
        <Button disabled={save.isPending} onClick={() => save.mutate({ elevenlabs_voice_id: id.trim() || null })}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null} Save
        </Button>
      </CardContent>
    </Card>
  );
}
