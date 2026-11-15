"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, FileText, MessageCircleQuestion, Loader2, RefreshCw, Trash2, Sparkles } from "lucide-react";
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
  last_synced_at: string | null;
  _count: { chunks: number };
}
interface Overview {
  sources: Source[];
  open_gaps: number;
  settings: { business_summary: string | null; auto_reply_mode: "off" | "draft" | "auto"; handoff_message: string | null } | null;
}
interface Gap { id: string; question: string; count: number }
interface TestResult { answer: string | null; reason?: string; sources: { title: string; url: string | null }[] }

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
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {x.type === "website" ? `${x.page_count} pages` : x.type === "faq" ? "FAQ" : "Note"}
                      {x.last_synced_at ? `, updated ${new Date(x.last_synced_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}
                    </p>
                    {x.error ? <p className="mt-0.5 text-xs text-destructive">{x.error}</p> : null}
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
                    <Button size="icon" variant="ghost" aria-label="Remove source" onClick={() => remove.mutate(x.id)}><Trash2 /></Button>
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
              {test.data.answer ? <p className="whitespace-pre-wrap">{test.data.answer}</p> : <p className="text-muted-foreground">{test.data.reason}</p>}
              {test.data.sources.length ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Used: {test.data.sources.map((x) => x.url ?? x.title).join(", ")}
                </p>
              ) : null}
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
            <Label htmlFor="summary">About your business</Label>
            <Textarea id="summary" rows={3} maxLength={1500} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="One or two sentences: what you sell, who for, where you operate." />
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
