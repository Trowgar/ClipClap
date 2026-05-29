"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, FolderOpen, House, Receipt, Gear, Handshake } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { UsageBar } from "./usage-bar";
import { UserNav } from "./user-nav";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/logo";

interface SidebarProps {
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
  };
}

const navItems = [
  { href: "/dashboard", label: "Home", icon: House },
  { href: "/dashboard/projects", label: "Projects", icon: FolderOpen },
  { href: "/dashboard/plans", label: "Plans", icon: CreditCard },
  { href: "/dashboard/billing", label: "Billing", icon: Receipt },
  { href: "/dashboard/referrals", label: "Affiliate", icon: Handshake },
  { href: "/dashboard/settings", label: "Settings", icon: Gear },
];

export function Sidebar({ user, usage }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-background">
      {/* Logo */}
      <div className="flex h-14 items-center px-4 border-b border-border">
        <Link href="/dashboard" className="flex items-center" aria-label="ClipClap home">
          <Logo className="h-6" />
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
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
      </nav>

      {/* Usage */}
      <div className="p-3">
        <UsageBar
          used={usage.minutesUsed}
          limit={usage.minutesLimit}
          topup={usage.topUpRemaining}
          plan={usage.plan}
        />
        {usage.plan !== "MAX" && (
          <Link
            href="/dashboard/plans"
            className="mt-2 block w-full rounded-md border border-border py-1.5 text-center text-xs font-medium transition-colors hover:bg-accent"
          >
            Upgrade
          </Link>
        )}
      </div>

      <Separator />

      {/* User */}
      <div className="p-3">
        <UserNav
          name={user.name}
          email={user.email}
          avatarUrl={user.avatarUrl}
        />
      </div>
    </aside>
  );
}
