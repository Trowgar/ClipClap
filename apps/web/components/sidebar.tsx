"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, CreditCard, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { UsageBar } from "./usage-bar";
import { UserNav } from "./user-nav";
import { Separator } from "@/components/ui/separator";

interface SidebarProps {
  user: {
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  usage: {
    used: number;
    limit: number;
    plan: string;
  };
}

const navItems = [
  { href: "/dashboard", label: "Home", icon: Home },
  { href: "/dashboard/plans", label: "Plans", icon: CreditCard },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ user, usage }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-background">
      {/* Logo */}
      <div className="flex h-14 items-center px-4 border-b border-border">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" fill="none" className="w-6 h-6">
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <rect x="8" y="7" width="10" height="18" rx="2.5" fill="none" stroke="black" strokeWidth="2" />
            <rect x="14" y="7" width="10" height="18" rx="2.5" fill="black" />
            <polygon points="18,13.5 18,18.5 21.5,16" fill="currentColor" />
          </svg>
          <span className="text-[15px] font-semibold tracking-tight">
            ClipClap
          </span>
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
        <UsageBar used={usage.used} limit={usage.limit} plan={usage.plan} />
        <Link
          href="/dashboard/plans"
          className="mt-2 block w-full rounded-md border border-border py-1.5 text-center text-xs font-medium transition-colors hover:bg-accent"
        >
          Upgrade
        </Link>
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
