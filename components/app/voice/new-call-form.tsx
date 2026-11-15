"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Phone, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FetchError, api } from "@/lib/fetcher";

interface ContactLite { id: string; full_name: string; phone: string; company?: string | null; dnc?: boolean }
interface Script { script: string; first_message: string; objections: string[] }
interface Voice { id: string; name: string; gender: string }

export function NewCallForm() {
  const router = useRouter();
  const { handleError } = useUpgradePrompt();
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [contact, setContact] = React.useState<ContactLite | null>(null);
  const [script, setScript] = React.useState("");
  const [firstMessage, setFirstMessage] = React.useState("");
  const [objections, setObjections] = React.useState<string[]>([]);
  const [voice, setVoice] = React.useState("");
  const [when, setWhen] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const contacts = useQuery({
    queryKey: ["voice-contact-search", debounced],
    queryFn: () => api<{ items: ContactLite[] }>(`/api/contacts?page_size=8${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`),
  });
  const voices = useQuery({ queryKey: ["voice-voices"], queryFn: () => api<Voice[]>("/api/voice/voices"), retry: false });

  const gen = useMutation({
    mutationFn: (c: ContactLite) => api<Script>("/api/voice/script", { method: "POST", json: { contactId: c.id } }),
    onSuccess: (s) => {
      setScript(s.script);
      setFirstMessage(s.first_message);
      setObjections(s.objections ?? []);
    },
    onError: (e) => {
      if (!handleError(e)) toast.error((e as Error).message);
    },
  });

  const call = useMutation({
    mutationFn: () =>
      api<{ aiCallId: string; scheduled: boolean }>("/api/voice/call", {
        method: "POST",
        json: {
          contactId: contact!.id,
          customScript: script.trim() || undefined,
          voiceId: voice || undefined,
          scheduledAt: when ? new Date(when).toISOString() : undefined,
        },
      }),
    onSuccess: (r) => {
      toast.success(r.scheduled ? "Call scheduled" : "Call started");
      router.push("/voice");
    },
    onError: (e) => {
      if (e instanceof FetchError && e.code === "DNC") {
        toast.error("This contact is on the Do-Not-Call list. AI calls to them are blocked.");
        return;
      }
      if (!handleError(e)) toast.error((e as Error).message);
    },
  });

  const pick = (c: ContactLite) => {
    setContact(c);
    setScript("");
    setFirstMessage("");
    setObjections([]);
    gen.mutate(c);
  };
  const dnc = contact?.dnc === true;

  return (
    <div className="max-w-3xl">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
        <Link href="/voice">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to calls
        </Link>
      </Button>
      <PageHeader title="New AI Call" description="Pick a contact, review the generated script, then call now or schedule." />

      <Card className="mb-4">
        <CardContent className="space-y-3 p-4">
          <Label>1. Contact</Label>
          {contact ? (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">{contact.full_name}</p>
                <p className="text-xs text-muted-foreground">
                  {contact.phone}
                  {contact.company ? ` · ${contact.company}` : ""}
                </p>
                {dnc ? <p className="mt-1 text-xs text-destructive">On the Do-Not-Call list. You cannot call this contact.</p> : null}
              </div>
              <Button variant="outline" size="sm" onClick={() => setContact(null)}>
                Change
              </Button>
            </div>
          ) : (
            <>
              <Input placeholder="Search by name, phone or company" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="divide-y rounded-lg border">
                {contacts.isLoading ? (
                  <p className="p-3 text-sm text-muted-foreground">Searching…</p>
                ) : contacts.isError ? (
                  <p className="p-3 text-sm text-destructive">{(contacts.error as Error).message}</p>
                ) : contacts.data?.items.length ? (
                  contacts.data.items.map((c) => (
                    <button key={c.id} type="button" onClick={() => pick(c)} className="flex w-full items-center justify-between p-3 text-left text-sm hover:bg-muted">
                      <span className="font-medium">{c.full_name}</span>
                      <span className="text-xs text-muted-foreground">
                        {c.phone}
                        {c.dnc ? " · DNC" : ""}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">No contacts found.</p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {contact ? (
        <>
          <Card className="mb-4">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="script">2. Call script</Label>
                <Button variant="outline" size="sm" disabled={gen.isPending} onClick={() => gen.mutate(contact)}>
                  <Sparkles className="mr-1 h-4 w-4" /> {gen.isPending ? "Generating…" : "Regenerate"}
                </Button>
              </div>
              {firstMessage ? (
                <p className="rounded-lg bg-muted p-3 text-sm">
                  <span className="font-medium">Opening line: </span>
                  {firstMessage}
                </p>
              ) : null}
              <Textarea id="script" rows={12} value={script} onChange={(e) => setScript(e.target.value)} placeholder={gen.isPending ? "Generating script…" : "Script will appear here. You can edit it."} />
              {objections.length ? (
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Likely objections</p>
                  <ul className="list-disc pl-4">
                    {objections.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="mb-4">
            <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>3. Voice</Label>
                <Select value={voice} onValueChange={setVoice} disabled={!voices.data?.length}>
                  <SelectTrigger>
                    <SelectValue placeholder={voices.isLoading ? "Loading voices…" : voices.isError ? "Voices unavailable" : "Default voice"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(voices.data ?? []).map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} ({v.gender})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="when">Schedule (optional)</Label>
                <Input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button disabled={call.isPending || dnc || gen.isPending} onClick={() => call.mutate()}>
              <Phone className="mr-1 h-4 w-4" />
              {call.isPending ? "Working…" : when ? "Schedule call" : "Call now"}
            </Button>
            <Button variant="outline" asChild>
              <Link href="/voice">Cancel</Link>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
