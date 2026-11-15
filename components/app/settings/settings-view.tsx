"use client";

import Link from "next/link";
import { CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/app/page-header";
import { useSettings } from "./use-settings";
import { GeneralTab } from "./general-tab";
import { EmailTab, VoiceTab, WhatsAppTab } from "./connections-tab";
import { ApiKeysTab } from "./api-keys-tab";
import { WhiteLabelTab } from "./white-label-tab";
import { AuditTab } from "./audit-tab";
import { DangerTab, DataExportTab } from "./data-danger-tabs";

export function SettingsView() {
  const q = useSettings();
  return (
    <div>
      <PageHeader title="Settings" description="Workspace, channels, API access and data." />
      {q.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full max-w-xl" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : q.isError || !q.data ? (
        <div className="rounded-xl border border-destructive/30 p-6 text-sm">
          <p className="text-destructive">{(q.error as Error | null)?.message ?? "Could not load settings."}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
        </div>
      ) : (
        <Tabs defaultValue="general">
          <div className="overflow-x-auto pb-1">
            <TabsList className="w-max">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
              <TabsTrigger value="email">Email</TabsTrigger>
              <TabsTrigger value="voice">Voice</TabsTrigger>
              <TabsTrigger value="billing">Billing</TabsTrigger>
              <TabsTrigger value="api">API</TabsTrigger>
              <TabsTrigger value="white-label">White-label</TabsTrigger>
              <TabsTrigger value="audit">Audit log</TabsTrigger>
              <TabsTrigger value="export">Data export</TabsTrigger>
              <TabsTrigger value="danger">Danger zone</TabsTrigger>
            </TabsList>
          </div>
          <div className="mt-4 max-w-3xl">
            <TabsContent value="general"><GeneralTab org={q.data} /></TabsContent>
            <TabsContent value="whatsapp"><WhatsAppTab org={q.data} /></TabsContent>
            <TabsContent value="email"><EmailTab org={q.data} /></TabsContent>
            <TabsContent value="voice"><VoiceTab org={q.data} /></TabsContent>
            <TabsContent value="billing">
              <Card>
                <CardHeader>
                  <CardTitle>Billing</CardTitle>
                  <CardDescription>You are on the <span className="font-medium capitalize">{q.data.plan}</span> plan.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button asChild><Link href="/billing"><CreditCard /> Manage plan and invoices</Link></Button>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="api"><ApiKeysTab org={q.data} /></TabsContent>
            <TabsContent value="white-label"><WhiteLabelTab org={q.data} /></TabsContent>
            <TabsContent value="audit"><AuditTab /></TabsContent>
            <TabsContent value="export"><DataExportTab /></TabsContent>
            <TabsContent value="danger"><DangerTab /></TabsContent>
          </div>
        </Tabs>
      )}
    </div>
  );
}
