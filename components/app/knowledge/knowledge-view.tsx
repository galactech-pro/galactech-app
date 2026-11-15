"use client";

import * as React from "react";
import { CrawlSummary, PagesPanel, type CrawlReport } from "@/components/app/knowledge/pages-panel";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, FileText, MessageCircleQuestion, Loader2, RefreshCw, Trash2, Sparkles, Lock, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/app/page-header";
import { api } from "@/lib/fetcher";

interface Source {
  id: string;
  type: "website" | "text" | "faq";
  title: string;
  url: string | null;
  content: string | null;
  status: "pending" | "syncing" | "ready" | "error";
  error: string | null;
  auto_sync: boolean;
  page_count: number;
  visibility: "public" | "private";
  last_result: { added?: string[]; updated?: string[]; removed?: string[]; report?: CrawlReport } | null;
  last_synced_at: string | null;
  _count: { chunks: number };
}
interface Overview {
  sources: Source[];
  open_gaps: number;
  settings: { business_summary: string | null; business_summary_auto?: boolean; auto_reply_mode: "off" | "draft" | "auto"; handoff_message: string | null } | null;
}
interface Gap { id: string; question: string; count: number }
interface TestResult { answer: string | null; reason?: string; sources: { title: string; url: string | null }[]; status?: "answered" | "partial" | "unknown"; missing?: string[]; confirmed?: boolean }

const MODE_HELP: Record<string, string> = {
  off: "The AI never replies on its own.",
  draft: "The AI writes a reply from your knowledge and a teammate approves it in Approvals. Recommended to start.",
  auto: "The AI sends replies itself, only when the answer is clearly in your knowledge. Everything else goes to a person.",
};

export function KnowledgeView() {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["knowledge"], queryFn: () => api<Overview>("/api/knowledge"), refetchInterval: (q) => (q.state.data?.sources.some((s) => s.status === "syncing") ? 4000 : false) });
  const gaps = useQuery({ queryKey: ["knowledge-gaps"], queryFn: () => api<Gap[]>("/api/knowledge/gaps") });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["knowledge"] });
    void qc.invalidateQueries({ queryKey: ["knowledge-gaps"] });
  };

  // add website
  const [site, setSite] = React.useState("");
  const addSite = useMutation({
    mutationFn: () => api<{ synced: boolean; error?: string }>("/api/knowledge", { method: "POST", json: { type: "website", url: site } }),
    onSuccess: (r) => {
      setSite("");
      refresh();
      r.synced ? toast.success("Website added and read") : toast.error(r.error ?? "Could not read the website");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // add text / faq
  const [kind, setKind] = React.useState<"text" | "faq">("faq");
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const addNote = useMutation({
    mutationFn: () => api("/api/knowledge", { method: "POST", json: { type: kind, title, content } }),
    onSuccess: () => {
      setTitle("");
      setContent("");
      refresh();
      toast.success("Added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resync = useMutation({
    mutationFn: (id: string) => api(`/api/knowledge/${id}/sync`, { method: "POST" }),
    onSuccess: () => {
      refresh();
      toast.success("Updated from the website");
    },
    onError: (e: Error) => {
      refresh();
      toast.error(e.message);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/knowledge/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const toggleSync = useMutation({
    mutationFn: (v: { id: string; auto_sync: boolean }) => api(`/api/knowledge/${v.id}`, { method: "PATCH", json: { auto_sync: v.auto_sync } }),
    onSuccess: refresh,
  });

  // private information (confirmed with an emailed one-time code)
  const [pTitle, setPTitle] = React.useState("");
  const [pContent, setPContent] = React.useState("");
  const [pending, setPending] = React.useState<{ otp_id: string; action: "add_private" | "delete"; sent_to: string } | null>(null);
  const [code, setCode] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement>(null);
  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 60_000) return void toast.error("That file is too large. Keep it under 60 KB of text.");
    if (!/\.(txt|md|csv|json)$/i.test(f.name)) return void toast.error("Upload a .txt, .md, .csv or .json file, or paste the text.");
    const r = new FileReader();
    r.onload = () => {
      setPContent(String(r.result ?? ""));
      if (!pTitle.trim()) setPTitle(f.name.replace(/\.[^.]+$/, ""));
    };
    r.readAsText(f);
  };
  const requestOtp = useMutation({
    mutationFn: (v: { action: "add_private"; title: string; content: string } | { action: "delete"; source_id: string }) =>
      api<{ otp_id: string; sent_to: string }>("/api/knowledge/otp", { method: "POST", json: v }),
    onSuccess: (r, v) => {
      setCode("");
      setPending({ otp_id: r.otp_id, action: v.action, sent_to: r.sent_to });
      toast.success(`We emailed a 6-digit code to ${r.sent_to}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const confirmOtp = useMutation({
    mutationFn: () => api("/api/knowledge/otp/confirm", { method: "POST", json: { otp_id: pending!.otp_id, code, action: pending!.action } }),
    onSuccess: () => {
      toast.success(pending?.action === "delete" ? "Removed" : "Saved as private information");
      setPending(null);
      setCode("");
      setPTitle("");
      setPContent("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [viewing, setViewing] = React.useState<string | null>(null);
  // settings
  const s = overview.data?.settings;
  const [summary, setSummary] = React.useState("");
  const [handoff, setHandoff] = React.useState("");
  const [mode, setMode] = React.useState<"off" | "draft" | "auto">("off");
  React.useEffect(() => {
    if (!s) return;
    setSummary(s.business_summary ?? "");
    setHandoff(s.handoff_message ?? "");
    setMode(s.auto_reply_mode);
  }, [s]);
  const rewriteProfile = useMutation({
    mutationFn: () => api<{ profile: string }>("/api/knowledge/profile", { method: "POST" }),
    onSuccess: (r) => {
      setSummary(r.profile);
      refresh();
      toast.success("Business profile rewritten");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const saveSettings = useMutation({
    mutationFn: () => api("/api/knowledge/settings", { method: "PUT", json: { business_summary: summary || null, handoff_message: handoff || null, auto_reply_mode: mode } }),
    onSuccess: () => {
      refresh();
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // test
  const [q, setQ] = React.useState("");
  const test = useMutation({ mutationFn: () => api<TestResult>("/api/knowledge/test", { method: "POST", json: { question: q } }), onError: (e: Error) => toast.error(e.message) });

  // gaps
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const answerGap = useMutation({
    mutationFn: (id: string) => api(`/api/knowledge/gaps/${id}`, { method: "POST", json: { answer: answers[id] } }),
    onSuccess: () => {
      refresh();
      toast.success("Saved. The AI will use this from now on.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const dismissGap = useMutation({ mutationFn: (id: string) => api(`/api/knowledge/gaps/${id}`, { method: "DELETE" }), onSuccess: refresh });

  const sources = overview.data?.sources ?? [];
  const totalSections = sources.reduce((n, x) => n + x._count.chunks, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Knowledge" description="What your AI knows about your business. It answers customers only from this, and tells you what it could not answer." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Globe className="h-4 w-4" /> Your website</CardTitle>
            <CardDescription>Paste your address. We read the pages and re-check them every day, so the AI stays current when your site changes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input value={site} onChange={(e) => setSite(e.target.value)} placeholder="yourbusiness.com" onKeyDown={(e) => e.key === "Enter" && site.trim() && addSite.mutate()} />
              <Button onClick={() => addSite.mutate()} disabled={!site.trim() || addSite.isPending}>
                {addSite.isPending ? <Loader2 className="animate-spin" /> : null} Add
              </Button>
            </div>
            {addSite.isPending ? <p className="text-xs text-muted-foreground">Reading your pages. This can take up to a minute.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" /> Add an answer or note</CardTitle>
            <CardDescription>Prices, hours, policies, delivery areas. Anything not on your website.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={kind} onValueChange={(v) => setKind(v as "text" | "faq")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="faq">A question and its answer</SelectItem>
                <SelectItem value="text">A longer note or document</SelectItem>
              </SelectContent>
            </Select>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "faq" ? "What are your opening hours?" : "Title, e.g. Pricing"} />
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} placeholder={kind === "faq" ? "We are open 9am to 7pm, Monday to Saturday." : "Paste the text here"} />
            <Button onClick={() => addNote.mutate()} disabled={!title.trim() || content.trim().length < (kind === "faq" ? 2 : 20) || addNote.isPending}>
              {addNote.isPending ? <Loader2 className="animate-spin" /> : null} Save
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Lock className="h-4 w-4" /> Private information</CardTitle>
          <CardDescription>
            Pricing sheets, internal policies, anything sensitive. Adding or removing it needs a code we email you. The AI may use it, but replies that use it always wait for a person to approve them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending ? (
            <div className="space-y-3 rounded-md border bg-secondary/40 p-3">
              <p className="text-sm">Enter the 6-digit code we sent to {pending.sent_to}. It works for 10 minutes.</p>
              <div className="flex flex-wrap gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="max-w-[160px] font-mono tracking-widest" onKeyDown={(e) => e.key === "Enter" && code.length === 6 && confirmOtp.mutate()} />
                <Button onClick={() => confirmOtp.mutate()} disabled={code.length !== 6 || confirmOtp.isPending}>
                  {confirmOtp.isPending ? <Loader2 className="animate-spin" /> : null} Confirm
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <Input value={pTitle} onChange={(e) => setPTitle(e.target.value)} placeholder="Title, e.g. Wholesale price list" maxLength={120} />
              <Textarea value={pContent} onChange={(e) => setPContent(e.target.value)} rows={5} placeholder="Paste the information, or upload a text file below" />
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileRef} type="file" accept=".txt,.md,.csv,.json,text/plain" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
                <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}><Upload /> Upload a file</Button>
                <Button onClick={() => requestOtp.mutate({ action: "add_private", title: pTitle, content: pContent })} disabled={!pTitle.trim() || pContent.trim().length < 10 || requestOtp.isPending}>
                  {requestOtp.isPending ? <Loader2 className="animate-spin" /> : null} Email me a code
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Text files only (.txt, .md, .csv, .json, up to 60 KB). For a PDF or Word file, paste the text.</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sources {sources.length ? <span className="font-normal text-muted-foreground">({totalSections} sections)</span> : null}</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Add your website above to get started.</p>
          ) : (
            <ul className="divide-y">
              {sources.map((x) => (
                <li key={x.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {x.type === "website" ? <Globe className="h-4 w-4 shrink-0" /> : x.type === "faq" ? <MessageCircleQuestion className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
                      <span className="truncate">{x.title}</span>
                      <Badge variant={x.status === "ready" ? "secondary" : x.status === "error" ? "destructive" : "outline"}>
                        {x.status === "syncing" ? "reading" : x.status}
                      </Badge>
                      {x.visibility === "private" ? <Badge variant="outline"><Lock className="mr-1 h-3 w-3" />private</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {x.type === "website" ? `${x.page_count} pages` : x.type === "faq" ? "FAQ" : "Note"}
                      {x.last_synced_at ? `, updated ${new Date(x.last_synced_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}
                    </p>
                    {x.error ? <p className="mt-0.5 text-xs text-destructive">{x.error}</p> : null}
                    {x.type === "website" && x.last_result?.report ? <CrawlSummary r={x.last_result.report} /> : null}
                    {x.visibility !== "private" && x._count.chunks > 0 ? (
                      <button type="button" className="mt-1 text-xs underline text-muted-foreground" onClick={() => setViewing(viewing === x.id ? null : x.id)}>{viewing === x.id ? "Hide what the AI read" : "See what the AI read"}</button>
                    ) : null}
                    {viewing === x.id ? <PagesPanel sourceId={x.id} /> : null}
                    {x.type === "website" && x.last_result && (x.last_result.added?.length || x.last_result.updated?.length || x.last_result.removed?.length) ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Last check: {x.last_result.added?.length ?? 0} new, {x.last_result.updated?.length ?? 0} updated, {x.last_result.removed?.length ?? 0} removed
                        {x.last_result.added?.length ? ` (new: ${x.last_result.added.slice(0, 2).map((u) => u.replace(/^https?:\/\/[^/]+/, "") || "/").join(", ")}${x.last_result.added.length > 2 ? "..." : ""})` : ""}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {x.type === "website" ? (
                      <>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input type="checkbox" checked={x.auto_sync} onChange={(e) => toggleSync.mutate({ id: x.id, auto_sync: e.target.checked })} /> Auto-update
                        </label>
                        <Button size="sm" variant="outline" onClick={() => resync.mutate(x.id)} disabled={resync.isPending && resync.variables === x.id}>
                          {resync.isPending && resync.variables === x.id ? <Loader2 className="animate-spin" /> : <RefreshCw />} Update now
                        </Button>
                      </>
                    ) : null}
                    <Button size="icon" variant="ghost" aria-label="Remove source" onClick={() => (x.visibility === "private" ? requestOtp.mutate({ action: "delete", source_id: x.id }) : remove.mutate(x.id))}><Trash2 /></Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> Try it</CardTitle>
          <CardDescription>Ask what a customer might ask. Nothing is sent to anyone.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Do you deliver to Hyderabad?" onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 3 && test.mutate()} />
            <Button onClick={() => test.mutate()} disabled={q.trim().length < 3 || test.isPending}>
              {test.isPending ? <Loader2 className="animate-spin" /> : null} Ask
            </Button>
          </div>
          {test.data ? (
            <div className="rounded-md border bg-secondary/40 p-3 text-sm">
              {test.data.status ? (
                <p className={`mb-2 text-xs font-medium ${test.data.confirmed ? "text-primary" : "text-amber-400"}`}>
                  {test.data.confirmed ? "Answered from your knowledge" : test.data.status === "unknown" ? "Not in your knowledge yet. Customers would get this holding reply and you would be alerted." : "Not fully covered by your knowledge. Add the missing details below."}
                </p>
              ) : null}
              {test.data.answer ? <p className="whitespace-pre-wrap">{test.data.answer}</p> : <p className="text-muted-foreground">{test.data.reason}</p>}
              {test.data.missing?.length ? <p className="mt-2 text-xs text-amber-400">Missing: {test.data.missing.join(", ")}</p> : null}
              {test.data.sources.length ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Based on: {test.data.sources.map((x) => x.url ?? x.title).join(", ")}
                </p>
              ) : test.data.confirmed === false ? <p className="mt-2 text-xs text-muted-foreground">No page in your knowledge states this directly.</p> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Questions the AI could not answer {overview.data?.open_gaps ? <Badge className="ml-2">{overview.data.open_gaps}</Badge> : null}</CardTitle>
          <CardDescription>Answer each one once and the AI knows it for next time. Most asked first.</CardDescription>
        </CardHeader>
        <CardContent>
          {!gaps.data?.length ? (
            <p className="text-sm text-muted-foreground">None yet. When a customer asks something that is not in your knowledge, it shows up here.</p>
          ) : (
            <ul className="space-y-4">
              {gaps.data.map((g) => (
                <li key={g.id} className="space-y-2">
                  <p className="text-sm font-medium">{g.question} {g.count > 1 ? <span className="font-normal text-muted-foreground">(asked {g.count} times)</span> : null}</p>
                  <Textarea rows={2} placeholder="Type the answer" value={answers[g.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [g.id]: e.target.value }))} />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => answerGap.mutate(g.id)} disabled={(answers[g.id] ?? "").trim().length < 2 || answerGap.isPending}>Save answer</Button>
                    <Button size="sm" variant="ghost" onClick={() => dismissGap.mutate(g.id)}>Dismiss</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Automatic replies</CardTitle>
          <CardDescription>Applies to every connected channel: WhatsApp, Telegram, email, web chat and more.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="draft">Suggest replies for approval</SelectItem>
                <SelectItem value="auto">Reply automatically</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{MODE_HELP[mode]}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="summary">Business profile</Label>
            <p className="text-xs text-muted-foreground">{s?.business_summary_auto ? "Written automatically from your website and notes, and refreshed every time they change." : "Written by you. The AI reads it before every answer."} Edit it to correct anything.</p>
            <Textarea id="summary" rows={9} maxLength={2500} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What you sell, who for, prices, location, hours, contact, policies, tone." />
            <Button type="button" size="sm" variant="outline" onClick={() => rewriteProfile.mutate()} disabled={rewriteProfile.isPending}>
              {rewriteProfile.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Rewrite from my knowledge
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="handoff">When the AI cannot answer</Label>
            <Input id="handoff" maxLength={300} value={handoff} onChange={(e) => setHandoff(e.target.value)} placeholder="Thanks for your message. A team member will get back to you shortly." />
            <p className="text-xs text-muted-foreground">Sent to the customer on chat channels, and the conversation is left open for your team.</p>
          </div>
          <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
            {saveSettings.isPending ? <Loader2 className="animate-spin" /> : null} Save settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
