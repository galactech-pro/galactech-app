"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSaveSettings, useSettings } from "./use-settings";

/** Fields added to GET/PATCH /api/settings by workstream S (build-against contract). */
interface OutreachFields {
  call_window_start?: number;
  call_window_end?: number;
  auto_outreach_enabled?: boolean;
  ai_approval_required?: boolean;
}

/**
 * Outreach & AI safety controls. Defaults are the safe ones: automatic outreach OFF, AI messages need approval.
 * The calling-hours default (09:00-21:00) is configurable because the legal rule behind it is unverified
 * (docs/OPEN_QUESTIONS.md); confirm with counsel.
 */
export function OutreachCard() {
  const { data } = useSettings();
  const save = useSaveSettings("Outreach settings saved");
  const o = (data ?? {}) as OutreachFields;
  const [auto, setAuto] = React.useState(o.auto_outreach_enabled ?? false);
  const [approval, setApproval] = React.useState(o.ai_approval_required ?? true);
  const [start, setStart] = React.useState(String(o.call_window_start ?? 9));
  const [end, setEnd] = React.useState(String(o.call_window_end ?? 21));

  React.useEffect(() => {
    if (!data) return;
    setAuto(o.auto_outreach_enabled ?? false);
    setApproval(o.ai_approval_required ?? true);
    setStart(String(o.call_window_start ?? 9));
    setEnd(String(o.call_window_end ?? 21));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!data) return null;
  const s = Number(start);
  const e = Number(end);
  const valid = Number.isInteger(s) && Number.isInteger(e) && s >= 0 && s <= 23 && e >= 1 && e <= 24 && s !== e;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Outreach &amp; AI safety</CardTitle>
        <CardDescription>Control when the platform may contact people on its own, and whether AI-written messages need a human check.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="auto-outreach">Automatic outreach</Label>
            <p className="text-xs text-muted-foreground">
              Lets workflows and automations message or call new contacts on their own. Only contacts with recorded consent are ever contacted. Off by default.
            </p>
          </div>
          <Switch id="auto-outreach" checked={auto} onCheckedChange={setAuto} />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="ai-approval">Require approval for AI-written messages</Label>
            <p className="text-xs text-muted-foreground">
              AI drafts appear under Approvals and are sent only after you approve them. Messages you type yourself and fixed templates are never held back.
            </p>
          </div>
          <Switch id="ai-approval" checked={approval} onCheckedChange={setApproval} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cw-start">AI calls allowed from (hour, 0-23)</Label>
            <Input id="cw-start" type="number" min={0} max={23} value={start} onChange={(ev) => setStart(ev.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cw-end">until (hour, 1-24)</Label>
            <Input id="cw-end" type="number" min={1} max={24} value={end} onChange={(ev) => setEnd(ev.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Hours are in your organisation timezone. Calls are never placed outside this window. Check the applicable calling rules for your country before widening it.
        </p>
        <Button
          disabled={save.isPending || !valid}
          onClick={() => save.mutate({ auto_outreach_enabled: auto, ai_approval_required: approval, call_window_start: s, call_window_end: e })}
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : null} Save
        </Button>
      </CardContent>
    </Card>
  );
}
