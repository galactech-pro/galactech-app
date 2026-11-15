"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { CheckCircle2, Loader2, Rocket, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormAlert } from "@/components/app/auth-bits";
import { Logo } from "@/components/app/sidebar";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { AUTOMATION_TEMPLATES } from "@/lib/templates/automation-templates";

interface Initial { name: string; timezone: string; language: string; step: number }
interface ContactRow { full_name: string; phone: string; email?: string }

const STEPS = ["Your business", "WhatsApp", "Contacts", "Automation", "Done"];
const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];
const LANGS: [string, string][] = [["en", "English"], ["hi", "Hindi"], ["ta", "Tamil"], ["te", "Telugu"], ["mr", "Marathi"], ["bn", "Bengali"]];

/** Parse "Name, phone, email" lines or CSV text into contact rows. */
function parseContacts(text: string): ContactRow[] {
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const rows = parsed.data;
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = head.some((h) => ["name", "full_name", "phone", "mobile", "email"].includes(h));
  const idx = (names: string[], fallback: number) => {
    const i = head.findIndex((h) => names.includes(h));
    return hasHeader ? i : fallback;
  };
  const ni = idx(["name", "full_name", "full name"], 0);
  const pi = idx(["phone", "mobile", "whatsapp", "phone number"], 1);
  const ei = idx(["email", "email address"], 2);
  return (hasHeader ? rows.slice(1) : rows)
    .map((r) => ({ full_name: (r[ni] ?? "").trim(), phone: (r[pi] ?? "").trim(), email: (r[ei] ?? "").trim() || undefined }))
    .filter((r) => r.full_name && r.phone);
}

export function Wizard({ initial }: { initial: Initial }) {
  const router = useRouter();
  const { handleError } = useUpgradePrompt();
  const [step, setStep] = React.useState(initial.step); // 0-based index
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [name, setName] = React.useState(initial.name);
  const [timezone, setTimezone] = React.useState(initial.timezone);
  const [language, setLanguage] = React.useState(initial.language);
  const [wa, setWa] = React.useState({ phone: "", waba: "", token: "" });
  const [raw, setRaw] = React.useState("");
  const [tpl, setTpl] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<{ wa: boolean; contacts: number; automation: boolean }>({ wa: false, contacts: 0, automation: false });

  const contacts = React.useMemo(() => parseContacts(raw), [raw]);

  async function save(payload: Record<string, unknown>, next: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ imported?: number }>("/api/onboarding", { method: "PATCH", json: payload });
      setStep(next);
      return res;
    } catch (e) {
      if (!handleError(e)) setError(e instanceof Error ? e.message : "Something went wrong");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) return setError("File too large (max 2 MB). Import bigger lists from the Contacts page later.");
    setRaw(await f.text());
  }

  async function finish() {
    setBusy(true);
    try {
      await api("/api/onboarding", { method: "PATCH", json: { step: 5 } });
      toast.success("You're all set!");
      router.replace("/dashboard");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  const skipBtn = (onClick: () => void) => (
    <Button type="button" variant="ghost" onClick={onClick} disabled={busy}>
      Skip for now
    </Button>
  );
  const spinner = busy ? <Loader2 className="animate-spin" /> : null;

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Logo />
        <span className="text-sm text-muted-foreground">Step {step + 1} of {STEPS.length}</span>
      </div>
      <Progress value={((step + 1) / STEPS.length) * 100} className="mb-2" aria-label="Onboarding progress" />
      <ol className="mb-6 hidden justify-between text-xs text-muted-foreground sm:flex">
        {STEPS.map((s, i) => (
          <li key={s} className={cn(i === step && "font-semibold text-primary")}>{s}</li>
        ))}
      </ol>

      <Card>
        {step === 0 && (
          <>
            <CardHeader>
              <CardTitle>Tell us about your business</CardTitle>
              <CardDescription>This personalises your messages and reports.</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim().length < 2) return setError("Enter your business name");
                  void save({ step: 1, name, timezone, language }, 1);
                }}
              >
                {error ? <FormAlert>{error}</FormAlert> : null}
                <div className="space-y-1.5">
                  <Label htmlFor="biz">Business name</Label>
                  <Input id="biz" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Timezone</Label>
                    <Select value={timezone} onValueChange={setTimezone}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{TIMEZONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Default language</Label>
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{LANGS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end"><Button type="submit" disabled={busy}>{spinner}Continue</Button></div>
              </form>
            </CardContent>
          </>
        )}

        {step === 1 && (
          <>
            <CardHeader>
              <CardTitle>Connect WhatsApp Business</CardTitle>
              <CardDescription>
                Find these in Meta Business Manager under WhatsApp, API Setup. Your token is encrypted before it is stored.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!wa.phone || !wa.waba || wa.token.length < 20) return setError("Fill in all three fields (token looks too short).");
                  void save({ step: 2, wa_phone_number_id: wa.phone, wa_business_account_id: wa.waba, wa_access_token: wa.token }, 2).then((r) => {
                    if (r) setSummary((s) => ({ ...s, wa: true }));
                  });
                }}
              >
                {error ? <FormAlert>{error}</FormAlert> : null}
                <div className="space-y-1.5">
                  <Label htmlFor="pid">Phone number ID</Label>
                  <Input id="pid" inputMode="numeric" value={wa.phone} onChange={(e) => setWa({ ...wa, phone: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="waba">WhatsApp Business Account ID</Label>
                  <Input id="waba" inputMode="numeric" value={wa.waba} onChange={(e) => setWa({ ...wa, waba: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tok">Permanent access token</Label>
                  <Input id="tok" type="password" autoComplete="off" value={wa.token} onChange={(e) => setWa({ ...wa, token: e.target.value })} />
                </div>
                <div className="flex items-center justify-between">
                  <Button type="button" variant="outline" onClick={() => { setError(null); setStep(0); }} disabled={busy}>Back</Button>
                  <div className="flex gap-2">
                    {skipBtn(() => void save({ step: 2, skip: true }, 2))}
                    <Button type="submit" disabled={busy}>{spinner}Connect</Button>
                  </div>
                </div>
              </form>
            </CardContent>
          </>
        )}

        {step === 2 && (
          <>
            <CardHeader>
              <CardTitle>Import your contacts</CardTitle>
              <CardDescription>Upload a CSV or paste one contact per line: name, phone, email. 10-digit Indian numbers are auto-formatted to +91.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error ? <FormAlert>{error}</FormAlert> : null}
              <Label htmlFor="csv" className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground hover:bg-muted/50">
                <Upload className="h-4 w-4" /> Choose a CSV file
                <input id="csv" type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
              </Label>
              <Textarea
                aria-label="Paste contacts"
                rows={6}
                placeholder={"Priya Sharma, 9876543210, priya@example.com\nRahul Verma, 9123456780"}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{contacts.length} contact{contacts.length === 1 ? "" : "s"} ready to import{contacts.length > 500 ? " (only the first 500 will be imported now)" : ""}.</p>
              <div className="flex items-center justify-between">
                <Button type="button" variant="outline" onClick={() => { setError(null); setStep(1); }} disabled={busy}>Back</Button>
                <div className="flex gap-2">
                  {skipBtn(() => void save({ step: 3, skip: true }, 3))}
                  <Button
                    disabled={busy || contacts.length === 0}
                    onClick={async () => {
                      const r = await save({ step: 3, contacts: contacts.slice(0, 500) }, 3);
                      if (r) setSummary((s) => ({ ...s, contacts: r.imported ?? 0 }));
                    }}
                  >
                    {spinner}Import {contacts.length || ""}
                  </Button>
                </div>
              </div>
            </CardContent>
          </>
        )}

        {step === 3 && (
          <>
            <CardHeader>
              <CardTitle>Pick an automation to start with</CardTitle>
              <CardDescription>It&apos;s created as a draft. You can edit and switch it on from Automations.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error ? <FormAlert>{error}</FormAlert> : null}
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Automation templates">
                {AUTOMATION_TEMPLATES.slice(0, 6).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={tpl === t.key}
                    onClick={() => setTpl(t.key)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      tpl === t.key ? "border-primary bg-accent" : "hover:bg-muted/50"
                    )}
                  >
                    <div className="text-sm font-semibold">{t.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <Button type="button" variant="outline" onClick={() => { setError(null); setStep(2); }} disabled={busy}>Back</Button>
                <div className="flex gap-2">
                  {skipBtn(() => void save({ step: 4, skip: true }, 4))}
                  <Button
                    disabled={busy || !tpl}
                    onClick={async () => {
                      const r = await save({ step: 4, template_key: tpl }, 4);
                      if (r) setSummary((s) => ({ ...s, automation: true }));
                    }}
                  >
                    {spinner}Use template
                  </Button>
                </div>
              </div>
            </CardContent>
          </>
        )}

        {step === 4 && (
          <>
            <CardHeader className="items-center text-center">
              <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-700">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <CardTitle className="text-xl">You&apos;re ready to go</CardTitle>
              <CardDescription>Your 7-day free trial is active.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error ? <FormAlert>{error}</FormAlert> : null}
              <ul className="space-y-2 text-sm">
                <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-green-600" /> Business profile saved</li>
                <li className="flex items-center gap-2"><CheckCircle2 className={cn("h-4 w-4", summary.wa ? "text-green-600" : "text-muted-foreground")} /> {summary.wa ? "WhatsApp connected" : "WhatsApp not connected yet (Settings, Integrations)"}</li>
                <li className="flex items-center gap-2"><CheckCircle2 className={cn("h-4 w-4", summary.contacts ? "text-green-600" : "text-muted-foreground")} /> {summary.contacts ? `${summary.contacts} contacts imported` : "No contacts imported yet"}</li>
                <li className="flex items-center gap-2"><CheckCircle2 className={cn("h-4 w-4", summary.automation ? "text-green-600" : "text-muted-foreground")} /> {summary.automation ? "Automation draft created" : "No automation yet"}</li>
              </ul>
              <Button className="w-full" size="lg" onClick={() => void finish()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Rocket />} Go to dashboard
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
