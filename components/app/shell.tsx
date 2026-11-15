"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, Settings, CreditCard } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Logo, Sidebar, SidebarNav } from "@/components/app/sidebar";
import { UpgradeProvider } from "@/components/app/upgrade-modal";

export interface ShellProps {
  orgName: string;
  userName: string | null;
  email: string;
  plan: string;
  trialEndsAt: string | null;
  emailVerified?: boolean;
  children: React.ReactNode;
}

function initials(s: string) {
  return s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "U";
}

export function Shell({ orgName, userName, email, plan, trialEndsAt, emailVerified = true, children }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [verifyMsg, setVerifyMsg] = React.useState<string | null>(null);

  async function resendVerification() {
    setVerifyMsg("Sending...");
    try {
      const res = await fetch("/api/auth/resend", { method: "POST" });
      setVerifyMsg(res.ok ? "Verification email sent. Check your inbox." : "Could not send right now. Try again in a few minutes.");
    } catch {
      setVerifyMsg("Network error. Try again.");
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  // Onboarding is a focused flow without app chrome.
  if (pathname.startsWith("/onboarding")) {
    return (
      <UpgradeProvider>
        <div className="min-h-screen bg-black">{children}</div>
      </UpgradeProvider>
    );
  }

  const daysLeft = trialEndsAt ? Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000) : null;
  const showTrial = plan === "free" && daysLeft !== null;

  return (
    <UpgradeProvider>
      <div className="flex h-screen overflow-hidden bg-black">
        <Sidebar />
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent side="left" className="border-sidebar-border bg-sidebar p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Main navigation</SheetDescription>
            <div className="flex h-16 items-center border-b border-sidebar-border px-5">
              <Logo />
            </div>
            <SidebarNav onNavigate={() => setDrawer(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          {!emailVerified ? (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900" role="status">
              <span>Please confirm your email address ({email}) to secure your account.</span>
              <button type="button" onClick={resendVerification} className="font-semibold underline underline-offset-2">Resend link</button>
              {verifyMsg ? <span className="text-xs">{verifyMsg}</span> : null}
            </div>
          ) : null}
          {showTrial ? (
            <div
              className={
                "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center text-sm " +
                (daysLeft! > 0 ? "bg-accent text-accent-foreground" : "bg-destructive text-destructive-foreground")
              }
              role="status"
            >
              <span>
                {daysLeft! > 0
                  ? `Free trial: ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`
                  : "Your free trial has ended. Upgrade to continue sending."}
              </span>
              <Link href="/billing" className="font-semibold underline underline-offset-2">
                Upgrade now
              </Link>
            </div>
          ) : null}

          <header className="flex h-16 shrink-0 items-center justify-between border-b bg-black/80 px-4 backdrop-blur sm:px-6">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
              <span className="truncate text-sm font-semibold">{orgName}</span>
              <span className="hidden rounded-sm border px-2 py-0.5 text-[11px] capitalize text-muted-foreground sm:inline">
                {plan}
              </span>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
                  <Avatar>
                    <AvatarFallback>{initials(userName || email)}</AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-[140px] truncate text-sm sm:inline">{userName || email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="truncate text-sm font-semibold">{userName || "Account"}</div>
                  <div className="truncate text-xs text-muted-foreground">{email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings /> Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/billing">
                    <CreditCard /> Billing
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={signOut} disabled={signingOut}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          <main className="flex-1 overflow-y-auto p-4 sm:p-8">
            <div className="mx-auto w-full max-w-7xl">{children}</div>
          </main>
        </div>
      </div>
    </UpgradeProvider>
  );
}
