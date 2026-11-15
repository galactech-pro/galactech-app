"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoUploader } from "./general-tab";
import type { OrgSettings } from "./types";
import { useSaveSettings } from "./use-settings";

export function WhiteLabelTab({ org }: { org: OrgSettings }) {
  const pro = org.plan === "pro";
  const [enabled, setEnabled] = React.useState(org.white_label);
  const [domain, setDomain] = React.useState(org.custom_domain ?? "");
  const save = useSaveSettings("White-label settings saved");

  if (!pro) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>White-label</CardTitle>
          <CardDescription>Use your own logo and domain. Available on the Pro plan.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild><Link href="/billing"><Sparkles /> Upgrade to Pro</Link></Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>White-label</CardTitle>
        <CardDescription>Present the workspace under your own brand.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Enable white-label</p>
            <p className="text-xs text-muted-foreground">Hides OmniReach branding where supported.</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable white-label" />
        </div>
        <LogoUploader org={org} label="Brand logo" />
        <div className="space-y-2">
          <Label htmlFor="cd">Custom domain</Label>
          <Input id="cd" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.yourbrand.com" />
          <p className="text-xs text-muted-foreground">
            This saves the domain only. You must also add a CNAME record pointing to this app and attach the domain in your hosting provider; DNS verification is not automated yet.
          </p>
        </div>
        <Button disabled={save.isPending} onClick={() => save.mutate({ white_label: enabled, custom_domain: domain.trim().toLowerCase() || null })}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null} Save
        </Button>
      </CardContent>
    </Card>
  );
}
