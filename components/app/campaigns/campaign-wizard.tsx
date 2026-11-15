"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Send, Sparkles, Users } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { CONTACT_STATUSES, errMsg, useDebounced, type Paged } from "@/components/app/contacts/types";
import { ChannelIcon, channelLabel } from "./channel-icon";
import { MERGE_TAGS, type Audience, type Campaign, type Channel } from "./types";

const STEPS = ["Channel", "Audience", "Message", "Preview", "Send"] as const;
const CHANNELS: { id: Channel; desc: string }[] = [
  { id: "whatsapp", desc: "Highest open rates. Free-form text or approved template." },
  { id: "email", desc: "Subject line plus rich body with unsubscribe link." },
  { id: "voice", desc: "AI agent calls each contact with a script." },
];
type Tone = "professional" | "friendly" | "urgent";

export function CampaignWizard() {
  const router = useRouter();
  const { handleError } = useUpgradePrompt();
  const [step, setStep] = React.useState(0);

  const [channel, setChannel] = React.useState<Channel>("whatsapp");
  const [name, setName] = React.useState("");
  const [allAudience, setAllAudience] = React.useState(true);
  const [tags, setTags] = React.useState("");
  const [scoreMin, setScoreMin] = React.useState("");
  const [scoreMax, setScoreMax] = React.useState("");
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [when, setWhen] = React.useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = React.useState("");
  const [createdId, setCreatedId] = React.useState<string | null>(null);

  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const subjectRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState<"subject" | "body">("body");

  const audience: Audience = React.useMemo(() => {
    if (allAudience) return { all: true };
    const a: Audience = {};
    const t = tags.split(",").map((x) => x.trim()).filter(Boolean);
    if (t.length) a.tags = t;
    if (scoreMin) a.score_min = Number(scoreMin);
    if (scoreMax) a.score_max = Number(scoreMax);
    if (statuses.length) a.status = statuses;
    return a;
  }, [allAudience, tags, scoreMin, scoreMax, statuses]);
  const debouncedAudience = useDebounced(audience, 400);

  // Live estimate using the contacts list total (opt-outs / DNC are excluded server-side at send time).
  const sizeQ = useQuery({
    queryKey: ["audience-size", debouncedAudience],
    queryFn: () => {
      const p = new URLSearchParams({ page_size: "1" });
      if (debouncedAudience.tags?.length) p.set("tags", debouncedAudience.tags.join(","));
      if (debouncedAudience.score_min) p.set("score_min", String(debouncedAudience.score_min));
      if (debouncedAudience.score_max) p.set("score_max", String(debouncedAudience.score_max));
      if (debouncedAudience.status?.length) p.set("status", debouncedAudience.status.join(","));
      return api<Paged<unknown>>(`/api/contacts?${p}`);
    },
    enabled: step >= 1,
  });

  const insertTag = (tag: string) => {
    if (focused === "subject" && channel === "email") {
      const el = subjectRef.current;
      const pos = el?.selectionStart ?? subject.length;
      setSubject(subject.slice(0, pos) + tag + subject.slice(pos));
    } else {
      const el = bodyRef.current;
      const pos = el?.selectionStart ?? body.length;
      setBody(body.slice(0, pos) + tag + body.slice(pos));
      requestAnimationFrame(() => el?.focus());
    }
  };

  // AI writer
  const [goal, setGoal] = React.useState("");
  const [tone, setTone] = React.useState<Tone>("friendly");
  const [alts, setAlts] = React.useState<string[]>([]);
  const [variants, setVariants] = React.useState<{ subject: string; predicted_open_rate: number }[]>([]);
  const gen = useMutation({
    mutationFn: () =>
      api<{ message: string; subject?: string; alternatives: string[] }>(channel === "email" ? "/api/ai/generate-email" : "/api/ai/generate-message", {
        method: "POST",
        json: { goal, tone, contact: { name: "there" }, ...(channel === "email" ? {} : { channel: "whatsapp" }) },
      }),
    onSuccess: (r) => {
      setBody(r.message);
      if (r.subject) setSubject(r.subject);
      setAlts(r.alternatives ?? []);
    },
    onError: (e) => {
      if (!handleError(e)) toast.error(errMsg(e));
    },
  });
  const subjects = useMutation({
    mutationFn: () => api<{ variants: { subject: string; predicted_open_rate: number }[] }>("/api/ai/subject-lines", { method: "POST", json: { goal: goal || name || "Campaign", body: body || undefined } }),
    onSuccess: (r) => setVariants(r.variants),
    onError: (e) => {
      if (!handleError(e)) toast.error(errMsg(e));
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const sched = when === "later" && scheduledAt ? new Date(scheduledAt).toISOString() : null;
      let id = createdId;
      if (!id) {
        const c = await api<Campaign>("/api/campaigns", {
          method: "POST",
          json: {
            name: name.trim(),
            channel,
            audience_filter: audience,
            content: { body: body || undefined, ...(channel === "email" ? { subject } : {}) },
            scheduled_at: sched,
          },
        });
        id = c.id;
        setCreatedId(id);
      }
      await api(`/api/campaigns/${id}/send`, { method: "POST", json: sched ? { scheduled_at: sched } : {} });
      return id;
    },
    onSuccess: (id) => {
      toast.success(when === "later" ? "Campaign scheduled" : "Campaign is sending");
      router.push(`/campaigns/${id}`);
    },
    onError: (e) => {
      if (!handleError(e)) toast.error(errMsg(e) + (createdId ? " (saved as draft, you can retry)" : ""));
    },
  });

  const sample = (t: string) => t.replace(/\{name\}/gi, "Rahul").replace(/\{full_name\}/gi, "Rahul Sharma").replace(/\{company\}/gi, "Acme Pvt Ltd");

  const contentOk = channel === "voice" || (body.trim().length > 0 && (channel !== "email" || subject.trim().length > 0));
  const scheduleOk = when === "now" || (scheduledAt && new Date(scheduledAt).getTime() > Date.now());
  const canNext = [name.trim().length > 0, true, contentOk, true, !!scheduleOk][step];

  const waLen = body.length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New campaign" description="Pick a channel, choose who gets it, write the message and send." />

      <ol className="mb-6 flex items-center gap-2 overflow-x-auto text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                i < step ? "bg-primary text-primary-foreground" : i === step ? "border-2 border-primary text-primary" : "bg-muted text-muted-foreground"
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className={cn("whitespace-nowrap", i === step ? "font-medium" : "text-muted-foreground")}>{s}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-5 p-5">
          {step === 0 && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="cname">Campaign name</Label>
                <Input id="cname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali offer - hot leads" />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {CHANNELS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setChannel(c.id)}
                    className={cn("rounded-xl border p-4 text-left transition-colors hover:bg-muted/50", channel === c.id && "border-primary bg-accent/50 ring-1 ring-primary")}
                  >
                    <ChannelIcon channel={c.id} className="mb-2 h-6 w-6 text-primary" />
                    <div className="font-medium">{channelLabel(c.id)}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{c.desc}</p>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex gap-2">
                <Button variant={allAudience ? "default" : "outline"} onClick={() => setAllAudience(true)}>
                  All contacts
                </Button>
                <Button variant={!allAudience ? "default" : "outline"} onClick={() => setAllAudience(false)}>
                  Filter audience
                </Button>
              </div>
              {!allAudience && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>Tags (any of, comma separated)</Label>
                    <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, webinar" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Score min</Label>
                    <Input type="number" min={1} max={10} value={scoreMin} onChange={(e) => setScoreMin(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Score max</Label>
                    <Input type="number" min={1} max={10} value={scoreMax} onChange={(e) => setScoreMax(e.target.value)} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>Status</Label>
                    <div className="flex flex-wrap gap-2">
                      {CONTACT_STATUSES.map((s) => {
                        const on = statuses.includes(s);
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setStatuses((p) => (on ? p.filter((x) => x !== s) : [...p, s]))}
                            className={cn("rounded-full border px-3 py-1 text-xs capitalize", on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}
                          >
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3 rounded-lg bg-muted/60 p-4">
                <Users className="h-5 w-5 text-primary" />
                <div>
                  <div className="text-xl font-semibold">{sizeQ.isLoading ? "..." : (sizeQ.data?.total ?? 0).toLocaleString("en-IN")} contacts</div>
                  <p className="text-xs text-muted-foreground">Matching your filters. Opted-out and Do-Not-Call contacts are excluded when you send.</p>
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-primary" /> AI writer
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Goal, e.g. Offer 20% off on annual plans this week" />
                  <Select value={tone} onValueChange={(v) => setTone(v as Tone)}>
                    <SelectTrigger className="sm:w-40" aria-label="Tone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button disabled={goal.trim().length < 3 || gen.isPending} onClick={() => gen.mutate()}>
                    {gen.isPending ? "Writing..." : "Generate"}
                  </Button>
                </div>
                {alts.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-muted-foreground">Alternatives (click to use)</p>
                    {alts.map((a, i) => (
                      <button key={i} type="button" onClick={() => setBody(a)} className="block w-full rounded-md border bg-background p-2 text-left text-sm hover:bg-accent">
                        {a}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {channel === "email" && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="subj">Subject</Label>
                    <Button variant="ghost" size="sm" onClick={() => subjects.mutate()} disabled={subjects.isPending}>
                      <Sparkles /> {subjects.isPending ? "Thinking..." : "AI subject lines"}
                    </Button>
                  </div>
                  <Input id="subj" ref={subjectRef} value={subject} onFocus={() => setFocused("subject")} onChange={(e) => setSubject(e.target.value)} />
                  {variants.length > 0 && (
                    <div className="space-y-1">
                      {variants.map((v, i) => (
                        <button key={i} type="button" onClick={() => setSubject(v.subject)} className="flex w-full items-center justify-between gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent">
                          <span>{v.subject}</span>
                          <Badge variant="success">{Math.round(v.predicted_open_rate)}% open</Badge>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="body">{channel === "voice" ? "Call script (optional)" : "Message"}</Label>
                  <div className="flex gap-1">
                    {MERGE_TAGS.map((t) => (
                      <Button key={t} type="button" variant="outline" size="sm" onClick={() => insertTag(t)}>
                        {t}
                      </Button>
                    ))}
                  </div>
                </div>
                <Textarea id="body" ref={bodyRef} rows={channel === "email" ? 10 : 6} value={body} onFocus={() => setFocused("body")} onChange={(e) => setBody(e.target.value)} />
                {channel === "whatsapp" && (
                  <p className={cn("text-xs", waLen > 160 ? "text-yellow-700" : "text-muted-foreground")}>
                    {waLen} characters. Messages under 160 characters get the best read rates. Use {"{name}"} to personalise.
                  </p>
                )}
                {channel === "voice" && <p className="text-xs text-muted-foreground">Leave empty to have the AI generate a script per contact.</p>}
              </div>
            </>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Preview with sample data (Rahul, Acme Pvt Ltd).</p>
              {channel === "email" ? (
                <div className="overflow-hidden rounded-lg border bg-white">
                  <div className="border-b bg-muted/40 p-3 text-sm">
                    <span className="text-muted-foreground">Subject: </span>
                    <span className="font-medium">{sample(subject)}</span>
                  </div>
                  <div className="whitespace-pre-wrap p-4 text-sm">{sample(body)}</div>
                </div>
              ) : (
                <div className="rounded-lg bg-[#e5ddd5] p-4">
                  <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg rounded-tr-none bg-[#dcf8c6] p-3 text-sm text-gray-900 shadow">
                    {sample(body) || "(AI will write the script per contact)"}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {channelLabel(channel)} | ~{sizeQ.data?.total ?? 0} contacts
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Button variant={when === "now" ? "default" : "outline"} onClick={() => setWhen("now")}>
                  Send now
                </Button>
                <Button variant={when === "later" ? "default" : "outline"} onClick={() => setWhen("later")}>
                  Schedule
                </Button>
              </div>
              {when === "later" && (
                <div className="space-y-1.5">
                  <Label htmlFor="sched">Send at</Label>
                  <Input id="sched" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
                  {scheduledAt && new Date(scheduledAt).getTime() <= Date.now() && <p className="text-xs text-destructive">Pick a time in the future.</p>}
                </div>
              )}
              <div className="rounded-lg border p-3 text-sm">
                <div className="font-medium">{name}</div>
                <div className="text-muted-foreground">
                  {channelLabel(channel)} to about {sizeQ.data?.total ?? 0} contacts
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 flex justify-between">
        <Button variant="outline" disabled={step === 0 || create.isPending} onClick={() => setStep((s) => s - 1)}>
          <ChevronLeft /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
            Next <ChevronRight />
          </Button>
        ) : (
          <Button disabled={!canNext || create.isPending} onClick={() => create.mutate()}>
            <Send /> {create.isPending ? "Working..." : when === "later" ? "Schedule campaign" : "Send campaign"}
          </Button>
        )}
      </div>
    </div>
  );
}
