"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, BookOpen, ClipboardCheck, CreditCard, Inbox, LayoutDashboard, Megaphone, Radio, Phone, Plug, Settings, UserCog, Users, Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Brand } from "@/components/app/brand";

interface NavItem { href: string; label: string; icon: LucideIcon }
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/contacts", label: "Contacts", icon: Users },
      { href: "/drafts", label: "Approvals", icon: ClipboardCheck },
      { href: "/knowledge", label: "Knowledge", icon: BookOpen },
    ],
  },
  {
    label: "Grow",
    items: [
      { href: "/campaigns", label: "Campaigns", icon: Megaphone },
      { href: "/automations", label: "Automations", icon: Workflow },
      { href: "/voice", label: "AI Voice", icon: Phone },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/channels", label: "Channels", icon: Radio },
      { href: "/integrations", label: "Integrations", icon: Plug },
      { href: "/team", label: "Team", icon: UserCog },
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/billing", label: "Billing", icon: CreditCard },
    ],
  },
];
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function Logo({ className }: { className?: string }) {
  return <Brand href="/dashboard" light className={className} />;
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {NAV_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="mb-1.5 px-3 text-[11px] uppercase tracking-wider text-sidebar-foreground/60">{g.label}</p>
          <div className="flex flex-col gap-0.5">
            {g.items.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + "/");
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "bg-sidebar-muted text-white" : "text-sidebar-foreground hover:bg-sidebar-muted hover:text-white"
                  )}
                >
                  {active ? <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 bg-white" /> : null}
                  <Icon className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-sidebar-foreground group-hover:text-white")} />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex h-16 items-center border-b border-sidebar-border px-5">
        <Logo />
      </div>
      <div className="flex-1 overflow-y-auto">
        <SidebarNav />
      </div>
      <div className="m-3 rounded-lg border border-sidebar-border bg-sidebar-muted/60 p-3 text-xs text-sidebar-foreground">
        <p className="font-semibold text-white">Need a hand?</p>
        <p className="mt-0.5 leading-relaxed">Connect a channel first, then import contacts.</p>
        <Link href="/channels" className="mt-2 inline-block text-white underline-offset-2 hover:underline">Connect channels →</Link>
      </div>
    </aside>
  );
}
