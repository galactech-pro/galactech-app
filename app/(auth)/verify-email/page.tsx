"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormAlert } from "@/components/app/auth-bits";
import { api } from "@/lib/fetcher";

function Verify() {
  const email = useSearchParams().get("email") ?? "";
  const [msg, setMsg] = React.useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function resend() {
    setBusy(true);
    try {
      await api("/api/auth/resend", { method: "POST" });
      setMsg({ kind: "success", text: "Verification email sent." });
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof Error ? e.message : "Could not send the email." });
    }
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-foreground">
          <MailCheck className="h-6 w-6" />
        </div>
        <CardTitle className="text-xl">Check your inbox</CardTitle>
        <CardDescription>
          We sent a verification link{email ? <> to <strong className="text-foreground">{email}</strong></> : null}. Click it to activate your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {msg ? <FormAlert kind={msg.kind}>{msg.text}</FormAlert> : null}
        <Button variant="outline" className="w-full" onClick={resend} disabled={busy}>
          Resend email
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Wrong address? <Link href="/signup" className="text-foreground underline underline-offset-2 hover:no-underline">Start over</Link> or{" "}
          <Link href="/login" className="text-foreground underline underline-offset-2 hover:no-underline">sign in</Link>.
        </p>
      </CardContent>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <React.Suspense>
      <Verify />
    </React.Suspense>
  );
}
