"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MailPlus, RefreshCw, Trash2, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { ConfirmDialog } from "@/components/app/settings/confirm-dialog";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { api } from "@/lib/fetcher";

type Role = "owner" | "admin" | "member" | "viewer";
interface Member { id: string; email: string; full_name: string | null; role: Role; is_active: boolean; last_seen_at: string | null; created_at: string }
interface Invite { id: string; email: string; role: Role; expires_at: string; created_at: string }
interface TeamData { members: Member[]; invites: Invite[] }
interface BillingLite { usage: { metrics: { team_seats: { used: number; limit: number } } } | null }

const ASSIGNABLE: Exclude<Role, "owner">[] = ["admin", "member", "viewer"];
const KEY = ["team"] as const;

export function TeamView() {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Exclude<Role, "owner">>("member");
  const [removing, setRemoving] = React.useState<Member | null>(null);
  const [revoking, setRevoking] = React.useState<Invite | null>(null);
  const [meId, setMeId] = React.useState<string | null>(null);

  React.useEffect(() => {
    api<{ id: string }>("/api/auth/me").then((d) => setMeId(d.id)).catch(() => undefined);
  }, []);

  const team = useQuery({ queryKey: KEY, queryFn: () => api<TeamData>("/api/team") });
  const billing = useQuery({ queryKey: ["billing"], queryFn: () => api<BillingLite>("/api/billing") });

  const me = team.data?.members.find((m) => m.id === meId);
  const isAdmin = me ? me.role === "owner" || me.role === "admin" : false;
  const seats = billing.data?.usage?.metrics.team_seats;

  const refresh = () => qc.invalidateQueries({ queryKey: KEY }).then(() => qc.invalidateQueries({ queryKey: ["billing"] }));
  const onErr = (e: Error) => { if (!handleError(e)) toast.error(e.message); };

  const invite = useMutation({
    mutationFn: () => api<{ email_sent: boolean }>("/api/team", { method: "POST", json: { email: email.trim(), role } }),
    onSuccess: (d) => {
      if (d.email_sent) toast.success("Invitation sent");
      else toast.warning("Invite created but the email could not be sent. Use Resend on the pending invite.");
      setInviteOpen(false);
      setEmail("");
      refresh();
    },
    onError: onErr,
  });
  const changeRole = useMutation({
    mutationFn: (v: { user_id: string; role: string }) => api("/api/team", { method: "PATCH", json: v }),
    onSuccess: () => { toast.success("Role updated"); refresh(); },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/team?user_id=${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Member removed"); setRemoving(null); refresh(); },
    onError: onErr,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/team?invite_id=${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Invite revoked"); setRevoking(null); refresh(); },
    onError: onErr,
  });
  const resend = useMutation({
    mutationFn: (id: string) => api<{ email_sent: boolean }>("/api/team/resend", { method: "POST", json: { invite_id: id } }),
    onSuccess: (d) => { d.email_sent ? toast.success("Invitation re-sent") : toast.warning("Invite refreshed but email could not be sent"); refresh(); },
    onError: onErr,
  });

  const active = team.data?.members.filter((m) => m.is_active) ?? [];
  const pct = seats && seats.limit > 0 ? Math.min(100, (seats.used / seats.limit) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Manage who has access to this workspace."
        actions={isAdmin ? <Button onClick={() => setInviteOpen(true)}><MailPlus /> Invite member</Button> : null}
      />

      {seats ? (
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Seats used</span>
              <span className="text-muted-foreground">{seats.used} / {seats.limit}</span>
            </div>
            <Progress value={pct} indicatorClassName={pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-yellow-500" : undefined} />
          </CardContent>
        </Card>
      ) : null}

      {team.isError ? (
        <div className="rounded-xl border border-destructive/30 p-6 text-sm">
          <p className="text-destructive">{(team.error as Error).message}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => team.refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Members</CardTitle></CardHeader>
            <CardContent>
              <DataTable<Member>
                loading={team.isLoading}
                rows={active}
                rowKey={(m) => m.id}
                empty="No members."
                columns={[
                  {
                    key: "who",
                    header: "Member",
                    cell: (m) => (
                      <div className="min-w-0">
                        <p className="truncate font-medium">{m.full_name ?? m.email}{m.id === meId ? <span className="ml-1 text-xs text-muted-foreground">(you)</span> : null}</p>
                        {m.full_name ? <p className="truncate text-xs text-muted-foreground">{m.email}</p> : null}
                      </div>
                    ),
                  },
                  {
                    key: "role",
                    header: "Role",
                    cell: (m) =>
                      m.role === "owner" ? (
                        <Badge>Owner</Badge>
                      ) : isAdmin ? (
                        <Select value={m.role} onValueChange={(v) => changeRole.mutate({ user_id: m.id, role: v })} disabled={changeRole.isPending}>
                          <SelectTrigger className="h-8 w-28 capitalize"><SelectValue /></SelectTrigger>
                          <SelectContent>{ASSIGNABLE.map((r) => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="secondary" className="capitalize">{m.role}</Badge>
                      ),
                  },
                  {
                    key: "seen",
                    header: "Last active",
                    cell: (m) => <span className="text-muted-foreground">{m.last_seen_at ? new Date(m.last_seen_at).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "Never"}</span>,
                    className: "hidden sm:table-cell",
                    headClassName: "hidden sm:table-cell",
                  },
                  {
                    key: "act",
                    header: "",
                    className: "w-12",
                    cell: (m) =>
                      isAdmin && m.role !== "owner" && m.id !== meId ? (
                        <Button variant="ghost" size="icon" aria-label={`Remove ${m.email}`} onClick={() => setRemoving(m)}>
                          <UserMinus className="h-4 w-4 text-destructive" />
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pending invites</CardTitle>
              <CardDescription>Invites expire after 7 days.</CardDescription>
            </CardHeader>
            <CardContent>
              {team.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <DataTable<Invite>
                  rows={team.data?.invites}
                  rowKey={(i) => i.id}
                  empty="No pending invites."
                  columns={[
                    { key: "email", header: "Email", cell: (i) => <span className="font-medium">{i.email}</span> },
                    { key: "role", header: "Role", cell: (i) => <Badge variant="secondary" className="capitalize">{i.role}</Badge> },
                    {
                      key: "exp",
                      header: "Expires",
                      cell: (i) => <span className="text-muted-foreground">{new Date(i.expires_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}</span>,
                      className: "hidden sm:table-cell",
                      headClassName: "hidden sm:table-cell",
                    },
                    {
                      key: "act",
                      header: "",
                      className: "w-28",
                      cell: (i) =>
                        isAdmin ? (
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" aria-label="Resend invite" disabled={resend.isPending} onClick={() => resend.mutate(i.id)}>
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label="Revoke invite" onClick={() => setRevoking(i)}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        ) : null,
                    },
                  ]}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite a teammate</DialogTitle>
            <DialogDescription>They will receive an email with a link to join your workspace.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="inv-email">Email</Label>
              <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
                <SelectTrigger className="capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>{ASSIGNABLE.map((r) => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || invite.isPending} onClick={() => invite.mutate()}>
              {invite.isPending ? <Loader2 className="animate-spin" /> : null} Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove team member?"
        description={`${removing?.email ?? "This member"} will lose access immediately and their assigned contacts become unassigned.`}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke invite?"
        description={`The invitation to ${revoking?.email ?? "this address"} will no longer work.`}
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}
