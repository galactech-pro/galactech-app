"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Check, CheckCheck, Clock, Inbox as InboxIcon, MessagesSquare, RotateCcw, Search, Send, Sparkles, UserCheck, UserMinus } from "lucide-react";
import { ChannelIcon } from "@/components/app/campaigns/channel-icon";
import type { Channel } from "@/components/app/campaigns/types";
import { ScoreBadge } from "@/components/app/score-badge";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FetchError, api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { errMsg, fmtDate, timeAgo, useDebounced, type Paged } from "@/components/app/contacts/types";

type Filter = "all" | "unread" | "hot" | "mine" | "unassigned";
const FILTERS: Filter[] = ["all", "unread", "mine", "unassigned", "hot"];
type ConvStatus = "open" | "pending" | "resolved";
const STATUSES: ConvStatus[] = ["open", "pending", "resolved"];

interface ContactLite {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  company: string | null;
  lead_score: number | null;
  wa_opt_out: boolean;
  email_opt_out?: boolean;
}
interface Convo {
  id: string;
  status: string;
  unread: number;
  contact: ContactLite | null;
  inbox: { id: string; channel: Channel; name: string };
  assignee: { id: string; full_name: string } | null;
  last_message: { content: string; direction: "inbound" | "outbound"; channel: string } | null;
  last_at: string;
}
interface ConvoList extends Paged<Convo> {
  unread_conversations: number;
  counts: Record<ConvStatus | "snoozed", number>;
}
interface Msg {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  channel: string;
  error: string | null;
  created_at: string;
}
interface Thread {
  conversation: { id: string; status: string; assignee_id: string | null; unread_count: number };
  contact: ContactLite & { score_reason?: string | null };
  inbox: { id: string; channel: Channel; name: string };
  messages: Msg[];
  session_window: { applies: boolean; open: boolean; expires_at: string | null };
  can_reply: boolean;
}

export function InboxView() {
  const sp = useSearchParams();
  // selected = a conversation id, or (legacy deep link ?contact=) a contact id resolved server-side
  const [selected, setSelected] = React.useState<{ conversationId?: string; contactId?: string } | null>(sp.get("contact") ? { contactId: sp.get("contact") as string } : null);
  const [status, setStatus] = React.useState<ConvStatus>("open");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const q = useDebounced(search);

  const list = useQuery({
    queryKey: ["inbox", status, filter, q],
    queryFn: () => api<ConvoList>(`/api/inbox?status=${status}&filter=${filter}&page_size=50${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="-m-4 flex h-[calc(100vh-4rem)] overflow-hidden border-y bg-card md:m-0 md:rounded-lg md:border">
      <aside className={cn("flex w-full flex-col border-r md:w-80 lg:w-96 md:flex", selected && "hidden")}>
        <div className="space-y-2 border-b p-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Inbox</h1>
            {list.data && list.data.unread_conversations > 0 && <Badge>{list.data.unread_conversations} unread</Badge>}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search conversations" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="flex gap-1">
            {STATUSES.map((st) => (
              <button
                key={st}
                onClick={() => setStatus(st)}
                className={cn("flex-1 rounded-md border px-2 py-1 text-xs font-medium capitalize", status === st ? "border-primary bg-accent" : "hover:bg-muted/70")}
              >
                {st}
                {list.data ? ` (${list.data.counts[st]})` : ""}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn("flex-1 rounded-md px-1 py-1 text-[11px] font-medium capitalize", filter === f ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70")}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : list.isError ? (
            <div className="p-6 text-center text-sm">
              <p className="mb-2 text-destructive">{errMsg(list.error)}</p>
              <Button size="sm" variant="outline" onClick={() => list.refetch()}>
                Retry
              </Button>
            </div>
          ) : list.data?.items.length === 0 ? (
            filter !== "all" || q ? (
              <p className="p-8 text-center text-sm text-muted-foreground">No conversations match your filters.</p>
            ) : (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-secondary text-foreground"><InboxIcon className="h-6 w-6" /></span>
                <p className="font-display text-sm font-semibold">Your inbox is empty</p>
                <p className="text-sm text-muted-foreground">Connect a channel and customer messages will appear here.</p>
                <Button asChild size="sm" variant="brand" className="mt-2"><Link href="/channels">Connect a channel</Link></Button>
              </div>
            )
          ) : (
            list.data?.items.map((c) =>
              c.contact ? (
                <button
                  key={c.id}
                  onClick={() => setSelected({ conversationId: c.id })}
                  className={cn("flex w-full items-start gap-3 border-b p-3 text-left hover:bg-muted/50", selected?.conversationId === c.id && "bg-accent/60")}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">{c.contact.full_name.charAt(0).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("flex items-center gap-1.5 truncate text-sm", c.unread > 0 ? "font-semibold" : "font-medium")}>
                        <ChannelIcon channel={c.inbox.channel} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{c.contact.full_name}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(c.last_at)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">
                        {c.last_message ? `${c.last_message.direction === "outbound" ? "You: " : ""}${c.last_message.content}` : ""}
                      </span>
                      {c.unread > 0 && <Badge className="h-5 min-w-5 justify-center px-1.5">{c.unread}</Badge>}
                    </div>
                  </div>
                </button>
              ) : null
            )
          )}
        </div>
      </aside>

      <section className={cn("min-w-0 flex-1 flex-col md:flex", selected ? "flex" : "hidden")}>
        {selected ? (
          <ThreadPane key={selected.conversationId ?? selected.contactId} target={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-secondary text-foreground"><MessagesSquare className="h-7 w-7" /></span>
            Select a conversation to start replying.
          </div>
        )}
      </section>
    </div>
  );
}

function Ticks({ status }: { status: Msg["status"] }) {
  if (status === "queued") return <Clock className="h-3 w-3" aria-label="Queued" />;
  if (status === "sent") return <Check className="h-3.5 w-3.5" aria-label="Sent" />;
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5" aria-label="Delivered" />;
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 text-sky-500" aria-label="Read" />;
  return <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="Failed" />;
}

function ThreadPane({ target, onBack }: { target: { conversationId?: string; contactId?: string }; onBack: () => void }) {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [text, setText] = React.useState("");
  const [tplOpen, setTplOpen] = React.useState(false);
  const [tplName, setTplName] = React.useState("");
  const [tplParams, setTplParams] = React.useState("");
  const endRef = React.useRef<HTMLDivElement>(null);

  const key = target.conversationId ?? target.contactId;
  const thread = useQuery({
    queryKey: ["inbox-thread", key],
    queryFn: () => api<Thread>(target.conversationId ? `/api/inbox/conversations/${target.conversationId}` : `/api/inbox/${target.contactId}`),
    refetchInterval: 10_000,
  });
  const convId = thread.data?.conversation.id;
  const contactId = thread.data?.contact.id;
  const unread = thread.data?.conversation.unread_count ?? 0;

  // mark read when a conversation with unread messages is open
  const markRead = useMutation({
    mutationFn: (id: string) => api(`/api/inbox/conversations/${id}/read`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["inbox"] }),
  });
  React.useEffect(() => {
    if (convId && unread > 0) markRead.mutate(convId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, unread]);

  const patch = useMutation({
    mutationFn: (b: { status?: ConvStatus; assignee_id?: string | null }) => api(`/api/inbox/conversations/${convId}`, { method: "PATCH", json: b }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inbox-thread", key] });
      void qc.invalidateQueries({ queryKey: ["inbox"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const msgCount = thread.data?.messages.length ?? 0;
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgCount]);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ["inbox-thread", key] });
    void qc.invalidateQueries({ queryKey: ["inbox"] });
  };
  const onErr = (e: unknown) => {
    if (!handleError(e)) toast.error(errMsg(e));
  };

  const reply = useMutation({
    mutationFn: () => api("/api/inbox/reply", { method: "POST", json: { conversationId: convId, text, client_id: crypto.randomUUID() } }),
    onSuccess: () => {
      setText("");
      done();
    },
    onError: (e) => {
      if (e instanceof FetchError && e.code === "SESSION_WINDOW_EXPIRED") {
        toast.error("24-hour window closed. Send an approved template instead.");
        setTplOpen(true);
        done();
        return;
      }
      onErr(e);
    },
  });
  const template = useMutation({
    mutationFn: () =>
      api("/api/inbox/reply", {
        method: "POST",
        json: { conversationId: convId, client_id: crypto.randomUUID(), template_name: tplName.trim(), template_params: tplParams.split(",").map((p) => p.trim()).filter(Boolean) },
      }),
    onSuccess: () => {
      toast.success("Template sent");
      setTplOpen(false);
      setTplName("");
      setTplParams("");
      done();
    },
    onError: onErr,
  });
  const aiReply = useMutation({
    mutationFn: () => api<{ message: string }>("/api/inbox/ai-reply", { method: "POST", json: { contactId: contactId as string } }),
    onSuccess: (r) => setText(r.message),
    onError: onErr,
  });

  if (thread.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-2/3" />
      </div>
    );
  }
  if (thread.isError || !thread.data) {
    return (
      <div className="p-8 text-center text-sm">
        <p className="mb-2 text-destructive">{errMsg(thread.error)}</p>
        <Button size="sm" variant="outline" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }
  const { contact, messages, session_window: win, conversation, inbox, can_reply } = thread.data;
  const optedOut = inbox.channel === "email" ? !!contact.email_opt_out : contact.wa_opt_out;
  const blocked = optedOut || !can_reply;
  const windowClosed = win.applies && !win.open;
  const resolved = conversation.status === "resolved";

  return (
    <>
      <header className="flex items-center gap-3 border-b p-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft />
        </Button>
        <ChannelIcon channel={inbox.channel} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <Link href={`/contacts/${contact.id}`} className="block truncate font-medium hover:underline">
            {contact.full_name}
          </Link>
          <div className="truncate text-xs text-muted-foreground">
            {inbox.name} | {inbox.channel === "email" ? contact.email : contact.phone}
            {contact.company ? ` | ${contact.company}` : ""}
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={patch.isPending} onClick={() => patch.mutate({ assignee_id: conversation.assignee_id ? null : "me" })}>
          {conversation.assignee_id ? <UserMinus /> : <UserCheck />} {conversation.assignee_id ? "Unassign" : "Assign to me"}
        </Button>
        <Button size="sm" variant={resolved ? "outline" : "default"} disabled={patch.isPending} onClick={() => patch.mutate({ status: resolved ? "open" : "resolved" })}>
          {resolved ? <RotateCcw /> : <Check />} {resolved ? "Reopen" : "Resolve"}
        </Button>
        <ScoreBadge score={contact.lead_score} reason={contact.score_reason} />
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto bg-muted/30 p-4">
        {messages.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.direction === "outbound" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm shadow-sm",
                m.direction === "outbound" ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-background"
              )}
            >
              {m.content}
              <div className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", m.direction === "outbound" ? "text-primary-foreground/80" : "text-muted-foreground")}>
                <span title={fmtDate(m.created_at, true)}>{new Date(m.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                {m.direction === "outbound" && <Ticks status={m.status} />}
              </div>
              {m.status === "failed" && m.error && <div className="mt-1 text-[10px] text-red-200">{m.error}</div>}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {windowClosed && !blocked && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">The 24-hour customer-service window is closed (last inbound message more than 24h ago). You can only send an approved template.</span>
          <Button size="sm" variant="outline" onClick={() => setTplOpen(true)}>
            Send template
          </Button>
        </div>
      )}
      {optedOut && <div className="border-t bg-red-50 px-3 py-2 text-xs text-red-800">This contact has opted out of this channel.</div>}
      {!can_reply && !optedOut && <div className="border-t bg-muted px-3 py-2 text-xs text-muted-foreground">This conversation is read-only.</div>}

      <form
        className="space-y-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) reply.mutate();
        }}
      >
        <Textarea
          rows={3}
          value={text}
          disabled={blocked}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) reply.mutate();
          }}
          placeholder={!windowClosed ? "Type a reply (Ctrl+Enter to send)" : "Window closed: use a template"}
        />
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={aiReply.isPending || blocked} onClick={() => aiReply.mutate()}>
            <Sparkles /> {aiReply.isPending ? "Thinking..." : "AI reply"}
          </Button>
          <Button type="submit" size="sm" disabled={!text.trim() || reply.isPending || blocked}>
            <Send /> {reply.isPending ? "Sending..." : "Send"}
          </Button>
        </div>
      </form>

      <Dialog open={tplOpen} onOpenChange={setTplOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send message template</DialogTitle>
            <DialogDescription>Approved WhatsApp templates can be sent outside the 24-hour window and re-open the conversation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Template name</Label>
              <Input id="tpl-name" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="follow_up_v1" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-params">Parameters (comma separated, in order)</Label>
              <Input id="tpl-params" value={tplParams} onChange={(e) => setTplParams(e.target.value)} placeholder={contact.full_name} />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={!tplName.trim() || template.isPending} onClick={() => template.mutate()}>
              {template.isPending ? "Sending..." : "Send template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
