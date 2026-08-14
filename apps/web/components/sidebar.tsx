"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, FolderOpen, House, Receipt, Gear, Handshake, Wallet } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { UsageBar } from "./usage-bar";
import { UserNav } from "./user-nav";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/logo";

export interface SidebarProps {
  user: {
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  usage: {
    minutesUsed: number;
    minutesLimit: number;
    topUpRemaining: number;
    plan: string;
    freeTrial: { usedMinutes: number; limitMinutes: number } | null;
  };
}

const navSections: {
  heading?: string;
  items: { href: string; label: string; icon: typeof House }[];
}[] = [
  {
    items: [
      { href: "/dashboard", label: "Home", icon: House },
      { href: "/dashboard/projects", label: "Projects", icon: FolderOpen },
    ],
  },
  {
    heading: "Earn",
    items: [
      { href: "/dashboard/referrals", label: "Affiliate", icon: Handshake },
      { href: "/dashboard/payouts", label: "Payouts", icon: Wallet },
    ],
  },
  {
    heading: "Account",
    items: [
      { href: "/dashboard/plans", label: "Plans", icon: CreditCard },
      { href: "/dashboard/billing", label: "Billing", icon: Receipt },
      { href: "/dashboard/settings", label: "Settings", icon: Gear },
    ],
  },
];

export function SidebarContent({
  user,
  usage,
  onNavigate,
}: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center px-4 border-b border-border">
        <Link href="/dashboard" className="flex items-center" aria-label="ClipClap home" onClick={onNavigate}>
          <Logo className="h-6" />
        </Link>
      </div>

      {/* Navigation */}
      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto p-3">
        {navSections.map((section, i) => (
          <div key={section.heading ?? i} className="space-y-1">
            {section.heading && (
              <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {section.heading}
              </div>
            )}
            {section.items.map((item) => {
              const isActive =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Usage */}
      <div className="shrink-0 p-3">
        <UsageBar
          used={usage.minutesUsed}
          limit={usage.minutesLimit}
          topup={usage.topUpRemaining}
          plan={usage.plan}
          freeTrial={usage.freeTrial}
        />
        {usage.plan !== "MAX" && (
          <Link
            href="/dashboard/plans"
            onClick={onNavigate}
            className="mt-2 block w-full rounded-md border border-border py-1.5 text-center text-xs font-medium transition-colors hover:bg-accent"
          >
            Upgrade
          </Link>
        )}
      </div>

      <Separator />

      {/* User */}
      <div className="shrink-0 p-3">
        <UserNav
          name={user.name}
          email={user.email}
          avatarUrl={user.avatarUrl}
        />
      </div>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="hidden h-full w-56 shrink-0 flex-col border-r border-border bg-background md:flex">
      <SidebarContent {...props} />
    </aside>
  );
}
