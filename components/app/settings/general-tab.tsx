"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/fetcher";
import { SETTINGS_KEY, type OrgSettings } from "./types";
import { useSaveSettings } from "./use-settings";

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Dhaka", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "UTC"];
const LANGUAGES = [
  { v: "en", l: "English" }, { v: "hi", l: "Hindi" }, { v: "ta", l: "Tamil" }, { v: "te", l: "Telugu" },
  { v: "mr", l: "Marathi" }, { v: "bn", l: "Bengali" }, { v: "gu", l: "Gujarati" },
];

export function LogoUploader({ org, label = "Logo" }: { org: OrgSettings; label?: string }) {
  const qc = useQueryClient();
  const ref = React.useRef<HTMLInputElement>(null);
  const up = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<{ logo_url: string }>("/api/settings/logo", { method: "POST", body: fd });
    },
    onSuccess: (d) => {
      qc.setQueryData<OrgSettings>(SETTINGS_KEY, (o) => (o ? { ...o, logo_url: d.logo_url } : o));
      toast.success("Logo updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border bg-muted text-xs text-muted-foreground">
          {org.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={org.logo_url} alt="Logo" className="h-full w-full object-contain" />
          ) : (
            "No logo"
          )}
        </div>
        <div>
          <input
            ref={ref}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) up.mutate(f);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={up.isPending} onClick={() => ref.current?.click()}>
            {up.isPending ? <Loader2 className="animate-spin" /> : <Upload />} Upload
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">PNG, JPG or WebP, up to 2 MB.</p>
        </div>
      </div>
    </div>
  );
}

export function GeneralTab({ org }: { org: OrgSettings }) {
  const [name, setName] = React.useState(org.name);
  const [tz, setTz] = React.useState(org.timezone);
  const [lang, setLang] = React.useState(org.language);
  const save = useSaveSettings();
  const tzs = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];
  const langs = LANGUAGES.some((l) => l.v === lang) ? LANGUAGES : [{ v: lang, l: lang }, ...LANGUAGES];
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Your workspace identity and regional defaults.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="org-name">Organisation name</Label>
          <Input id="org-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <LogoUploader org={org} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Timezone</Label>
            <Select value={tz} onValueChange={setTz}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{tzs.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Language</Label>
            <Select value={lang} onValueChange={setLang}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{langs.map((l) => <SelectItem key={l.v} value={l.v}>{l.l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <Button disabled={save.isPending || !name.trim()} onClick={() => save.mutate({ name: name.trim(), timezone: tz, language: lang })}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null} Save changes
        </Button>
      </CardContent>
    </Card>
  );
}
